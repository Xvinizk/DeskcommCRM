import { randomUUID, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { sanitizeFlowForSnapshot } from "@/lib/followup/sharing/sanitize";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

function gerarTokenSeguro(): string {
  return randomBytes(24).toString("base64url");
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data: share, error } = await admin
    .from("followup_flow_shares")
    .select("id, token, status, snapshot, created_at, updated_at")
    .eq("pointer_id", id)
    .eq("organization_id", activeOrg.orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  if (!share) {
    return ok({ has_share: false }, { requestId });
  }

  const snap = share.snapshot as Record<string, unknown> | null;

  return ok(
    {
      has_share: true,
      token: share.token,
      status: share.status,
      snapshot_date: share.updated_at || share.created_at,
      node_count: snap?.node_count ?? 0,
      image_count: snap?.image_count ?? 0,
      video_count: snap?.video_count ?? 0,
      audio_count: snap?.audio_count ?? 0,
      share_path: `/fluxos/compartilhado/${share.token}`,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let body: { action?: "create" | "update_snapshot" | "generate_new_token" } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // body opcional
  }

  const action = body.action ?? "create";

  const admin = createAdminClient();
  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const graph = await rascunhoDoFluxo(
    admin,
    pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
    activeOrg.orgId,
  );

  const snapshot = sanitizeFlowForSnapshot({
    name: pointer.name,
    handoff_policy: pointer.handoff_policy as "pause" | "cancel" | "allow",
    trigger_config: pointer.trigger_config as Record<string, unknown>,
    graph: graph as unknown as FlowGraph,
  });

  // Verificar se já existe um share ativo
  const { data: existingShare } = await admin
    .from("followup_flow_shares")
    .select("id, token")
    .eq("pointer_id", id)
    .eq("organization_id", activeOrg.orgId)
    .eq("status", "active")
    .maybeSingle();

  let token = existingShare?.token;

  if (existingShare && action === "update_snapshot") {
    // Atualizar snapshot do link existente mantendo o token
    const { error: updErr } = await admin
      .from("followup_flow_shares")
      .update({
        snapshot,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingShare.id);

    if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  } else {
    // Se for generate_new_token, revoga o anterior
    if (existingShare && action === "generate_new_token") {
      await admin
        .from("followup_flow_shares")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", existingShare.id);
    }

    if (!existingShare || action === "generate_new_token") {
      token = gerarTokenSeguro();
      const { error: insErr } = await admin.from("followup_flow_shares").insert({
        organization_id: activeOrg.orgId,
        pointer_id: id,
        token,
        status: "active",
        snapshot,
        created_by: user.id,
      });

      if (insErr) return fail("internal_error", insErr.message, 500, { requestId });
    }
  }

  void audit({
    action: "followup_flow.shared",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_share",
    resourceId: id,
    requestId,
    metadata: { token, action },
  });

  return ok(
    {
      has_share: true,
      token,
      status: "active",
      snapshot_date: new Date().toISOString(),
      node_count: snapshot.node_count,
      image_count: snapshot.image_count,
      video_count: snapshot.video_count,
      audio_count: snapshot.audio_count,
      share_path: `/fluxos/compartilhado/${token}`,
    },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { error } = await admin
    .from("followup_flow_shares")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("pointer_id", id)
    .eq("organization_id", activeOrg.orgId)
    .eq("status", "active");

  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "followup_flow.share_revoked",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_share",
    resourceId: id,
    requestId,
  });

  return ok({ revoked: true }, { requestId });
}

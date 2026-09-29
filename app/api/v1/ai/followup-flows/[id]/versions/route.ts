import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

const createBackupSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  graph: flowGraphSchema.optional(),
});

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
  const { data: versions, error } = await admin
    .from("followup_flow_versions")
    .select("id, pointer_id, created_at, created_by, label, kind, graph")
    .eq("organization_id", activeOrg.orgId)
    .eq("pointer_id", id)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const mapped = (versions ?? []).map((v) => {
    const g = v.graph as unknown as FlowGraph;
    const nodes = g?.nodes ?? [];
    return {
      id: v.id,
      created_at: v.created_at,
      created_by: v.created_by,
      label: v.label || (v.kind === "publish" ? "Publicação" : "Backup"),
      kind: v.kind || "publish",
      node_count: nodes.length,
      image_count: nodes.filter((n) => n.type === "message_image").length,
      video_count: nodes.filter((n) => n.type === "message_video").length,
      audio_count: nodes.filter((n) => n.type === "message_audio").length,
    };
  });

  return ok({ versions: mapped }, { requestId });
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

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // corpo opcional
  }

  const parsed = createBackupSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos para o backup."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, draft_graph, active_version_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const graphToSave =
    parsed.data.graph ??
    (await rascunhoDoFluxo(
      admin,
      pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
      activeOrg.orgId,
    ));

  const backupLabel = parsed.data.label || `Backup de ${new Date().toLocaleString("pt-BR")}`;

  const { data: inserted, error: insertErr } = await admin
    .from("followup_flow_versions")
    .insert({
      organization_id: activeOrg.orgId,
      pointer_id: id,
      graph: graphToSave,
      created_by: user.id,
      label: backupLabel,
      kind: "manual_backup",
    })
    .select("id, created_at, label, kind")
    .single();

  if (insertErr || !inserted) {
    return fail("internal_error", insertErr?.message || "Erro ao salvar backup.", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_version",
    resourceId: inserted.id,
    requestId,
    metadata: { label: backupLabel, kind: "manual_backup" },
  });

  return ok(
    {
      id: inserted.id,
      label: inserted.label,
      kind: inserted.kind,
      created_at: inserted.created_at,
    },
    { requestId },
  );
}

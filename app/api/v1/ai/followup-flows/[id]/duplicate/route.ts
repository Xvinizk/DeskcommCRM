import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
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

  const admin = createAdminClient();

  const { data: sourcePointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, handoff_policy, trigger_config, active_version_id, draft_graph")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!sourcePointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const resolvedGraph = await rascunhoDoFluxo(
    admin,
    sourcePointer as unknown as { draft_graph: unknown; active_version_id: string | null },
    activeOrg.orgId,
  );

  let copyName = `${sourcePointer.name} (${t("Cópia")})`;
  let counter = 2;
  while (true) {
    const { data: existingName } = await admin
      .from("followup_flow_pointers")
      .select("id")
      .eq("organization_id", activeOrg.orgId)
      .eq("name", copyName)
      .maybeSingle();
    if (!existingName) break;
    copyName = `${sourcePointer.name} (${t("Cópia")} ${counter})`;
    counter++;
  }

  const { data: created, error: insertErr } = await admin
    .from("followup_flow_pointers")
    .insert({
      organization_id: activeOrg.orgId,
      name: copyName,
      status: "draft",
      draft_graph: resolvedGraph,
      handoff_policy: sourcePointer.handoff_policy ?? "pause",
      trigger_config: sourcePointer.trigger_config ?? { kind: "manual" },
    })
    .select("id, name, status, active_version_id, handoff_policy, updated_at, archived_at")
    .single();

  if (insertErr || !created) {
    return fail("internal_error", insertErr?.message ?? "followup_flow_duplicate_failed", 500, {
      requestId,
    });
  }

  audit({
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    action: "followup_flow.duplicated",
    resourceType: "followup_flow",
    resourceId: created.id,
    metadata: {
      source_flow_id: id,
      new_flow_name: copyName,
    },
    requestId,
  });

  return ok(created, { requestId });
}

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, versionId } = await ctx.params;

  if (!UUID_RX.test(id) || !UUID_RX.test(versionId)) {
    return fail("invalid_request", "IDs inválidos.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const admin = createAdminClient();

  // 1. Buscar o fluxo de origem
  const { data: pointer, error: pointerErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, handoff_policy, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (pointerErr) return fail("internal_error", pointerErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  // 2. Buscar a versão
  const { data: version, error: versionErr } = await admin
    .from("followup_flow_versions")
    .select("id, graph, label")
    .eq("id", versionId)
    .eq("pointer_id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (versionErr) return fail("internal_error", versionErr.message, 500, { requestId });
  if (!version) return fail("not_found", t("Versão não encontrada."), 404, { requestId });

  const duplicateName = `${pointer.name} (Cópia da ${version.label || "versão"})`;

  const result = await importFlowIntoOrg({
    admin,
    targetOrgId: activeOrg.orgId,
    userId: user.id,
    flowName: duplicateName,
    handoffPolicy: pointer.handoff_policy as "pause" | "cancel" | "allow",
    triggerConfig: pointer.trigger_config as Record<string, unknown>,
    graph: version.graph as unknown as FlowGraph,
  });

  if (!result.ok || !result.flow_id) {
    return fail("internal_error", result.error || t("Falha ao duplicar versão do fluxo."), 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: result.flow_id,
    requestId,
    metadata: {
      action: "duplicate_version",
      source_flow_id: id,
      source_version_id: versionId,
    },
  });

  return ok(
    {
      flow_id: result.flow_id,
      flow_name: result.flow_name,
      message: t("Fluxo duplicado com sucesso."),
    },
    { requestId },
  );
}

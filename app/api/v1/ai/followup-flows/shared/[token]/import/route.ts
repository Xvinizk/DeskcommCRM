import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import type { SharedFlowSnapshot } from "@/lib/followup/sharing/sanitize";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ token: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || typeof token !== "string" || token.length < 10) {
    return fail("invalid_request", "Token inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data: share, error } = await admin
    .from("followup_flow_shares")
    .select("id, token, status, snapshot, organization_id")
    .eq("token", token)
    .eq("status", "active")
    .maybeSingle();

  if (error || !share) {
    return fail("not_found", t("Fluxo compartilhado não encontrado ou link desativado."), 404, {
      requestId,
    });
  }

  const snapshot = share.snapshot as unknown as SharedFlowSnapshot;
  if (!snapshot || !snapshot.graph) {
    return fail("validation_failed", t("Snapshot do fluxo inválido ou corrompido."), 422, {
      requestId,
    });
  }

  const result = await importFlowIntoOrg({
    admin,
    targetOrgId: activeOrg.orgId,
    userId: user.id,
    flowName: snapshot.flow_name,
    handoffPolicy: snapshot.handoff_policy,
    triggerConfig: snapshot.trigger_config,
    graph: snapshot.graph,
  });

  if (!result.ok || !result.flow_id) {
    return fail("internal_error", result.error || t("Falha ao importar o fluxo."), 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.imported",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: result.flow_id,
    requestId,
    metadata: {
      share_id: share.id,
      flow_name: result.flow_name,
      warnings_count: result.warnings?.length ?? 0,
    },
  });

  return ok(
    {
      flow_id: result.flow_id,
      flow_name: result.flow_name,
      warnings: result.warnings,
      message: t("Fluxo importado com sucesso"),
    },
    { requestId },
  );
}

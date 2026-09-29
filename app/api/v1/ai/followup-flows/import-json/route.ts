import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { flowExportJsonSchema } from "@/lib/followup/sharing/json-schema";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Arquivo ou corpo JSON inválido."), 400, { requestId });
  }

  const parsed = flowExportJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("O arquivo JSON não segue o formato ou versão esperada."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { flow, nodes, edges } = parsed.data;

  const admin = createAdminClient();
  const result = await importFlowIntoOrg({
    admin,
    targetOrgId: activeOrg.orgId,
    userId: user.id,
    flowName: flow.name,
    handoffPolicy: flow.handoff_policy,
    triggerConfig: flow.trigger_config,
    graph: { nodes, edges },
  });

  if (!result.ok || !result.flow_id) {
    return fail("internal_error", result.error || t("Falha ao importar o fluxo do JSON."), 500, {
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
      source: "json_import",
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

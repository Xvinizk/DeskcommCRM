import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/ai/followup-flows/:id/permanent — exclusão permanente transacional (manager+).
 * Exige confirmação explícita com o nome do fluxo:
 * { "confirmation_name": "<nome exato>" }
 *
 * Bloqueia se houver execuções ativas ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual') -> 409
 * Bloqueia se referenciado por versão publicada de agente ativo -> 409
 * Bloqueia se houver tarefas em execução associadas em job_queue -> 409
 *
 * Purga histórico de execuções finalizadas, versões, compartilhamentos e o pointer atomicamente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getFollowupFlowDeletionSummary,
  permanentlyDeleteFollowupFlow,
} from "@/lib/followup/delete";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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

  let body: { confirmation_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional if caller tries query param, but we enforce body for strong confirmation
  }

  const confirmationName = (body.confirmation_name ?? "").trim();
  if (!confirmationName) {
    return fail("invalid_request", "Nome de confirmação não informado.", 400, { requestId });
  }

  const admin = createAdminClient();

  // Obter resumo antes da exclusão para registrar na trilha de auditoria
  const summaryRes = await getFollowupFlowDeletionSummary(admin, {
    orgId: activeOrg.orgId,
    pointerId: id,
  });

  const deleteResult = await permanentlyDeleteFollowupFlow(admin, {
    orgId: activeOrg.orgId,
    pointerId: id,
    confirmationName,
  });

  if (!deleteResult.ok) {
    let status = 409;
    if (deleteResult.code === "not_found") status = 404;
    else if (deleteResult.code === "confirmation_mismatch") status = 400;
    else if (deleteResult.code === "internal_error") status = 500;

    return fail(deleteResult.code, deleteResult.message, status, { requestId });
  }

  // Auditoria registrada após validação com contadores prévios
  audit({
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    action: "followup_flow.permanently_deleted",
    resourceType: "followup_flow",
    resourceId: id,
    metadata: {
      flow_name: summaryRes.data?.flow_name ?? confirmationName,
      purged_counts: summaryRes.data
        ? {
            versions: summaryRes.data.versions_count,
            completed_enrollments: summaryRes.data.completed_enrollments,
            cancelled_enrollments: summaryRes.data.cancelled_enrollments,
            total_events: summaryRes.data.total_events_count,
          }
        : null,
      timestamp: new Date().toISOString(),
    },
    requestId,
  });

  return ok({ id, permanently_deleted: true }, { requestId });
}

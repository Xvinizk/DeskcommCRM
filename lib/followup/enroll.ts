import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
/**
 * Inscrição de um contato num fluxo publicado.
 *
 * Extraído do POST /api/v1/ai/followups/enrollments para o mesmo caminho
 * servir a ação de webhook (service-role + organization_id da regra).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  createSupabaseFollowupGateDb,
  resolveAgentForAutomaticTrigger,
} from "@/lib/followup/agent-followup-gate";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { cancelEnrollment, LIVE_STATUSES } from "@/lib/followup/cancel";

export const ENROLLMENT_LIST_COLUMNS =
  "id, pointer_id, version_id, contact_id, status, current_node_id, next_eval_at, outcome, started_at, completed_at, updated_at";

export type EnrollFollowupInput = {
  organizationId: string;
  resolveServiceBoundary?: () => Promise<ServiceBoundary>;
  pointerId: string;
  contactId: string;
  agentId?: string;
  conversationId?: string;
  replaceActive?: boolean;
  origin?: "keyword_trigger" | "manual_trigger" | "stage_change" | "silence" | "webhook" | string;
  triggerMetadata?: Record<string, unknown>;
  actorUserId: string | null;
  requestId: string;
};

export type EnrollFollowupOk = { ok: true; enrollment: Record<string, unknown> };
export type EnrollFollowupErr = {
  ok: false;
  code: string;
  message: string;
  status: number;
  activeEnrollment?: {
    id: string;
    pointerId: string;
    flowName: string;
  };
};
export type EnrollFollowupResult = EnrollFollowupOk | EnrollFollowupErr;

export async function enrollFollowupFlow(
  supabase: SupabaseClient,
  input: EnrollFollowupInput,
): Promise<EnrollFollowupResult> {
  const { organizationId, pointerId, contactId, requestId } = input;

  const { data: pointer, error: pointerErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id")
    .eq("organization_id", organizationId)
    .eq("id", pointerId)
    .maybeSingle();
  if (pointerErr) return { ok: false, code: "internal_error", message: pointerErr.message, status: 500 };
  if (!pointer) return { ok: false, code: "not_found", message: "Fluxo não encontrado.", status: 404 };

  if (pointer.status !== "active" || !pointer.active_version_id) {
    return {
      ok: false,
      code: "flow_not_active",
      message: "Fluxo não está ativo (precisa estar publicado).",
      status: 422,
    };
  }

  const { data: contact, error: contactErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) return { ok: false, code: "internal_error", message: contactErr.message, status: 500 };
  if (!contact) return { ok: false, code: "not_found", message: "Contato não encontrado.", status: 404 };

  // Checar se já existe enrollment ativo na organização para este contato (1 por lead)
  const { data: activeRows, error: activeErr } = await supabase
    .from("followup_enrollments")
    .select("id, pointer_id, status, followup_flow_pointers(id, name)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", [...LIVE_STATUSES])
    .order("started_at", { ascending: false })
    .limit(1);

  if (activeErr) {
    return { ok: false, code: "internal_error", message: activeErr.message, status: 500 };
  }

  const existingActive = activeRows?.[0];
  if (existingActive) {
    if (input.replaceActive) {
      // Cancelar o anterior canonicamente com motivo manual_replacement
      const cancelRes = await cancelEnrollment(supabase, {
        enrollmentId: existingActive.id,
        organizationId,
        reason: "manual_replacement",
        actorUserId: input.actorUserId,
        requestId,
      });
      if (!cancelRes.ok) {
        return {
          ok: false,
          code: "replacement_failed",
          message: `Falha ao encerrar fluxo ativo anterior: ${cancelRes.message}`,
          status: cancelRes.status,
        };
      }
    } else {
      const activeFlowName =
        (existingActive as unknown as { followup_flow_pointers?: { name?: string } | null })
          ?.followup_flow_pointers?.name ?? "Fluxo atual";
      return {
        ok: false,
        code: "conflict",
        message: `Este contato já está no fluxo: ${activeFlowName}`,
        status: 409,
        activeEnrollment: {
          id: existingActive.id,
          pointerId: existingActive.pointer_id,
          flowName: activeFlowName,
        },
      };
    }
  }

  const { data: version, error: versionErr } = await supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", pointer.active_version_id)
    .maybeSingle();
  if (versionErr) return { ok: false, code: "internal_error", message: versionErr.message, status: 500 };
  if (!version) {
    return { ok: false, code: "internal_error", message: "Version ativa do fluxo não encontrada.", status: 500 };
  }

  const graph = flowGraphSchema.parse(version.graph);
  const triggerNode = graph.nodes.find((n) => n.type === "trigger");
  if (!triggerNode) {
    return { ok: false, code: "internal_error", message: "Grafo publicado sem nó trigger.", status: 500 };
  }

  // Task 8.6: fixa qual agente arma este enrollment. Se o caller passou agentId,
  // valida que é um agente DA ORG (nunca confia no body pra tenancy). Senão,
  // resolve do próprio pointer (agentes publicados que o habilitam) — mesmo
  // pick determinístico do silence-sweep. Sem nenhum resolvível → null (ok).
  let agentId: string | null = null;
  if (input.agentId !== undefined) {
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", input.agentId)
      .maybeSingle();
    if (agentErr) return { ok: false, code: "internal_error", message: agentErr.message, status: 500 };
    if (!agent) return { ok: false, code: "not_found", message: "Agente não encontrado.", status: 404 };
    agentId = input.agentId;
  } else {
    agentId = await resolveAgentForAutomaticTrigger(
      createSupabaseFollowupGateDb(supabase),
      organizationId,
      pointerId,
    );
  }

  let channelSessionId: string | undefined = undefined;
  if (input.conversationId) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id, contact_id, channel_session_id")
      .eq("organization_id", organizationId)
      .eq("id", input.conversationId)
      .maybeSingle();
    if (convErr) {
      return { ok: false, code: "internal_error", message: convErr.message, status: 500 };
    }
    if (conv) {
      if (conv.contact_id && conv.contact_id !== contactId) {
        return {
          ok: false,
          code: "invalid_request",
          message: "A conversa informada pertence a outro contato.",
          status: 400,
        };
      }
      if (conv.channel_session_id) {
        channelSessionId = conv.channel_session_id;
      }
    }
  }

  let boundary: ServiceBoundary;
  try {
    boundary = input.resolveServiceBoundary
      ? await input.resolveServiceBoundary()
      : await beginServiceAtOrigin(supabase, organizationId, contactId, channelSessionId);
    if (input.resolveServiceBoundary) await assertServiceBoundarySupabase(supabase, boundary);
  } catch (err: unknown) {
    const errObj = (typeof err === "object" && err !== null ? err : {}) as {
      message?: string;
      code?: string;
      details?: string;
    };
    const msg =
      err instanceof Error
        ? err.message
        : typeof errObj.message === "string"
          ? errObj.message
          : typeof errObj.details === "string"
            ? errObj.details
            : String(err);
    if (msg.includes("service_channel_not_found")) {
      return {
        ok: false,
        code: "service_channel_not_found",
        message: "Nenhum canal ativo ou conectado para iniciar o atendimento deste contato.",
        status: 422,
      };
    }
    if (msg.includes("service_contact_not_found")) {
      return {
        ok: false,
        code: "not_found",
        message: "Contato não encontrado.",
        status: 404,
      };
    }
    if (msg.includes("service_scope_mismatch")) {
      return {
        ok: false,
        code: "forbidden",
        message: "Contato pertence a outra organização.",
        status: 403,
      };
    }
    return {
      ok: false,
      code: "service_boundary_failed",
      message: msg,
      status: 500,
    };
  }
  const conversationId = boundary.conversation_id;

  const { data: created, error: insErr } = await supabase
    .from("followup_enrollments")
    .insert({
      organization_id: organizationId,
      pointer_id: pointerId,
      version_id: pointer.active_version_id,
      contact_id: contactId,
      current_node_id: triggerNode.id,
      status: "active",
      agent_id: agentId,
      service_boundary: boundary,
      conversation_id: conversationId,
    })
    .select(ENROLLMENT_LIST_COLUMNS)
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return {
        ok: false,
        code: "conflict",
        message: "Este contato já está em um follow-up ativo (1 por lead na organização).",
        status: 409,
      };
    }
    return {
      ok: false,
      code: "internal_error",
      message: insErr?.message ?? "followup_enrollment_insert_failed",
      status: 500,
    };
  }

  const origin = input.origin ?? (input.actorUserId ? "manual_trigger" : "system_trigger");
  if (origin === "keyword_trigger") {
    await supabase.from("followup_enrollment_events").insert({
      organization_id: organizationId,
      enrollment_id: created.id,
      node_id: triggerNode.id,
      event_type: "enrolled_by_keyword",
      payload: {
        keyword: input.triggerMetadata?.keyword ?? null,
        message_id: input.triggerMetadata?.message_id ?? null,
      },
    });
  } else if (origin === "manual_trigger") {
    await supabase.from("followup_enrollment_events").insert({
      organization_id: organizationId,
      enrollment_id: created.id,
      node_id: triggerNode.id,
      event_type: "enrolled_manual",
      payload: {
        actor_user_id: input.actorUserId,
        replaced_enrollment_id: existingActive?.id ?? null,
        conversation_id: conversationId,
      },
    });
  }

  void audit({
    action: "followup_enrollment.created",
    actorUserId: input.actorUserId,
    organizationId,
    resourceType: "followup_enrollment",
    resourceId: created.id,
    requestId,
    metadata: {
      pointer_id: pointerId,
      contact_id: contactId,
      conversation_id: conversationId,
      version_id: pointer.active_version_id,
      agent_id: agentId,
      origin,
      replaced_enrollment_id: existingActive?.id ?? null,
      ...(input.triggerMetadata ?? {}),
    },
  });

  return { ok: true, enrollment: created as Record<string, unknown> };
}

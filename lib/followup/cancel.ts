import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export const LIVE_STATUSES = [
  "active",
  "waiting_reply",
  "paused_handoff",
  "paused_manual",
] as const;

export type LiveEnrollmentStatus = (typeof LIVE_STATUSES)[number];

export interface CancelEnrollmentInput {
  enrollmentId: string;
  organizationId: string;
  reason: "manual" | "manual_replacement" | string;
  actorUserId?: string | null;
  requestId?: string;
}

export type CancelEnrollmentResult =
  | { ok: true; enrollment: Record<string, unknown> }
  | { ok: false; code: string; message: string; status: number };

/**
 * Cancelamento canônico de um enrollment de follow-up.
 *
 * Reutilizado pelo POST /api/v1/ai/followups/enrollments/:id/cancel
 * e pelo mecanismo de substituição (manual replacement / conflito).
 */
export async function cancelEnrollment(
  supabase: SupabaseClient,
  input: CancelEnrollmentInput,
): Promise<CancelEnrollmentResult> {
  const { enrollmentId, organizationId, reason, actorUserId, requestId } = input;

  const { data: existing, error: fetchErr } = await supabase
    .from("followup_enrollments")
    .select("id, status, current_node_id")
    .eq("id", enrollmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, code: "internal_error", message: fetchErr.message, status: 500 };
  }
  if (!existing) {
    return { ok: false, code: "not_found", message: "Enrollment não encontrado.", status: 404 };
  }

  if (!LIVE_STATUSES.includes(existing.status as LiveEnrollmentStatus)) {
    return { ok: false, code: "already_terminal", message: "Enrollment já está encerrado.", status: 409 };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: reason,
      next_eval_at: null,
      claimed_until: null,
      outcome: null,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", enrollmentId)
    .eq("organization_id", organizationId)
    .select("id, status, cancel_reason, updated_at")
    .single();

  if (updErr || !updated) {
    return {
      ok: false,
      code: "internal_error",
      message: updErr?.message ?? "followup_enrollment_cancel_failed",
      status: 500,
    };
  }

  const eventType = reason === "manual_replacement" ? "cancelled_replacement" : "cancelled_manual";
  const { error: eventErr } = await supabase.from("followup_enrollment_events").insert({
    organization_id: organizationId,
    enrollment_id: enrollmentId,
    node_id: existing.current_node_id,
    event_type: eventType,
    payload: {
      actor_user_id: actorUserId ?? null,
      reason,
    },
  });

  if (eventErr) {
    logger.error("[followup.enrollment.cancel] event insert failed", {
      error: eventErr.message,
      requestId,
      enrollmentId,
    });
  }

  void audit({
    action: "followup_enrollment.cancelled",
    actorUserId: actorUserId ?? null,
    organizationId,
    resourceType: "followup_enrollment",
    resourceId: enrollmentId,
    requestId,
    metadata: {
      previous_status: existing.status,
      reason,
    },
  });

  return { ok: true, enrollment: updated as Record<string, unknown> };
}

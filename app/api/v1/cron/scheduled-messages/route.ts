import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { defaultMimeForType, sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SendMessageInput } from "@/lib/schemas";
import type { Actor } from "@/lib/api/handlers/types";
import type { ScheduledMessageRow } from "@/lib/schemas/scheduled-messages";

export const dynamic = "force-dynamic";

const BATCH_LIMIT = 20;
const LEASE_SECONDS = 120; // 2 minutos de lease para o worker

/**
 * Classifica se um erro é definitivo (não deve tentar novamente)
 * ou transitório (pode tentar novamente se attempts < max_attempts).
 */
export function isDefinitiveError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if ([400, 403, 404, 422].includes(err.status)) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const definitivePatterns = [
    "contact_anonymized",
    "missing_phone_number",
    "is_blocked",
    "bloqueado",
    "not_found",
    "não encontrado",
    "não encontrada",
    "invalid_payload",
    "payload_too_large",
    "unsupported_media_type",
  ];
  return definitivePatterns.some((pattern) => msg.includes(pattern));
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Autenticação canônica de crons fail-closed
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const provided = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();

  // 1. Claim atômico e concorrente com lease recovery (FOR UPDATE SKIP LOCKED)
  const { data: claimedData, error: claimErr } = await admin.rpc(
    "fn_claim_due_scheduled_messages",
    { p_limit: BATCH_LIMIT, p_lease_seconds: LEASE_SECONDS }
  );

  if (claimErr) {
    logger.error("[scheduled-messages.cron] erro ao executar claim", {
      error: claimErr.message,
      requestId,
    });
    return fail("internal_error", "Erro ao executar claim de mensagens programadas.", 500, {
      requestId,
    });
  }

  const claimed = (claimedData ?? []) as ScheduledMessageRow[];
  if (claimed.length === 0) {
    return ok(
      { claimed: 0, sent: 0, failed: 0, retried: 0, recovered: 0 },
      { requestId }
    );
  }

  let sentCount = 0;
  let failedCount = 0;
  let retriedCount = 0;
  let recoveredCount = 0;

  for (const sm of claimed) {
    try {
      // 2. Prevenção de Double-Send e Idempotência:
      // Se a mensagem já possui sent_message_id gravado, não reenviar.
      if (sm.sent_message_id) {
        await admin
          .from("scheduled_messages")
          .update({
            status: "sent",
            claimed_until: null,
            sent_at: sm.sent_at || new Date().toISOString(),
          })
          .eq("id", sm.id);
        recoveredCount++;
        continue;
      }

      const idempotencyKey = `scheduled_msg_${sm.id}`;

      // Se o worker anterior caiu logo após o provedor enviar ou persistir a mensagem em `messages`:
      const { data: existingMsg } = await admin
        .from("messages")
        .select("id, status, external_id, created_at")
        .eq("organization_id", sm.organization_id)
        .eq("conversation_id", sm.conversation_id)
        .or(`id.eq.${sm.id},metadata->>scheduled_message_id.eq.${sm.id},metadata->>idempotency_key.eq.${idempotencyKey}`)
        .maybeSingle();

      if (existingMsg) {
        const isConfirmedSent =
          (existingMsg.status === "sent" ||
            existingMsg.status === "delivered" ||
            existingMsg.status === "read") &&
          Boolean(existingMsg.external_id);

        if (isConfirmedSent) {
          // Regra 2: Se existe registro com status = 'sent' e external_id preenchido -> confirmado
          await admin
            .from("scheduled_messages")
            .update({
              status: "sent",
              sent_message_id: existingMsg.id,
              sent_at: existingMsg.created_at,
              claimed_until: null,
              last_error: null,
            })
            .eq("id", sm.id);
          recoveredCount++;
          continue;
        }

        // Regra 3: Se existe registro em messages com status = 'queued' e external_id ausente
        // Política AT-MOST-ONCE: NÃO reenviar automaticamente para evitar double-send
        const ambiguityReason =
          "lease_expired_unconfirmed: Uma mensagem programada para este contato ficou em estado não confirmado. " +
          "O sistema não pode garantir se ela chegou ao WhatsApp. Para evitar envio duplicado, ela não foi reenviada automaticamente.";

        await admin
          .from("scheduled_messages")
          .update({
            status: "failed",
            sent_message_id: existingMsg.id,
            claimed_until: null,
            last_error: ambiguityReason,
          })
          .eq("id", sm.id);

        // Regra 4: Criar aviso na Central de Avisos existente
        try {
          await admin.from("agent_inbox_items").insert({
            organization_id: sm.organization_id,
            kind: "message_send_stuck",
            severity: "critical",
            title: "Mensagem programada não confirmada",
            body:
              "Uma mensagem programada para este contato ficou em estado não confirmado. " +
              "O sistema não pode garantir se ela chegou ao WhatsApp. Para evitar envio duplicado, ela não foi reenviada automaticamente.",
            ref_kind: "conversation",
            ref_id: sm.conversation_id,
          });
        } catch (inboxErr) {
          logger.warn("[scheduled-messages.cron] falha ao registrar aviso na Central", {
            error: inboxErr instanceof Error ? inboxErr.message : String(inboxErr),
            scheduledMessageId: sm.id,
          });
        }

        failedCount++;
        continue;
      }

      // 3. Monta payload para o pipeline canônico sendMessageHandler
      const actor: Actor = sm.created_by
        ? { type: "user", id: sm.created_by }
        : { type: "webhook_source", id: "scheduled_messages" };

      const messageType = sm.media_storage_path
        ? (sm.media_type as "image" | "video" | "audio") || "image"
        : "text";

      const sendInput: SendMessageInput = {
        conversation_id: sm.conversation_id,
        type: messageType,
        body: sm.media_storage_path
          ? sm.caption || sm.body || undefined
          : sm.body || "",
        ...(sm.media_storage_path
          ? {
              media_storage_path: sm.media_storage_path,
              media_mime: sm.media_mime || defaultMimeForType(messageType),
            }
          : {}),
        metadata: {
          idempotency_key: idempotencyKey,
          scheduled_message_id: sm.id,
          attempt: sm.attempts,
        },
      };

      // 4. Executa pipeline canônico: pacing, anti-ban, Storage sign, provedor de canal e persistência em messages.
      // O `internalMessageId: sm.id` ancora a identidade atômica na tabela `messages`.
      const sentMessage = await sendMessageHandler(
        admin,
        {
          organization_id: sm.organization_id,
          actor,
          requestId,
          idioma: "pt-BR",
          internalMessageId: sm.id,
        },
        sendInput
      );

      // 5. Sucesso real: atualiza scheduled_messages para 'sent'
      await admin
        .from("scheduled_messages")
        .update({
          status: "sent",
          sent_message_id: sentMessage.id,
          sent_at: new Date().toISOString(),
          claimed_until: null,
          last_error: null,
        })
        .eq("id", sm.id);

      sentCount++;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isDefinitive = isDefinitiveError(err);

      logger.warn("[scheduled-messages.cron] falha ao processar envio", {
        scheduled_message_id: sm.id,
        attempts: sm.attempts,
        max_attempts: sm.max_attempts,
        isDefinitive,
        error: errorMsg,
        requestId,
      });

      if (!isDefinitive && sm.attempts < sm.max_attempts) {
        // Falha transitória: reagenda com backoff exponencial (ex: 2m, 4m, 8m...)
        const backoffMin = Math.min(60, Math.pow(2, sm.attempts));
        const nextSchedule = new Date(Date.now() + backoffMin * 60_000).toISOString();

        await admin
          .from("scheduled_messages")
          .update({
            status: "pending",
            scheduled_for: nextSchedule,
            claimed_until: null,
            last_error: errorMsg,
          })
          .eq("id", sm.id);

        retriedCount++;
      } else {
        // Falha definitiva ou limite esgotado: status = 'failed'
        await admin
          .from("scheduled_messages")
          .update({
            status: "failed",
            claimed_until: null,
            last_error: errorMsg,
          })
          .eq("id", sm.id);

        failedCount++;
      }
    }
  }

  if (claimed.length > 0) {
    audit({
      action: "scheduled_message.cron_run",
      organizationId: null,
      bypassedRls: true,
      requestId,
      metadata: {
        claimed: claimed.length,
        sent: sentCount,
        retried: retriedCount,
        failed: failedCount,
        recovered: recoveredCount,
      },
    });
  }

  return ok(
    {
      claimed: claimed.length,
      sent: sentCount,
      retried: retriedCount,
      failed: failedCount,
      recovered: recoveredCount,
    },
    { requestId }
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

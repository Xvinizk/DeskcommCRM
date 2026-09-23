import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/conversations/[id]/scheduled-messages/[msgId] — edita ou reagenda mensagem pendente.
 * DELETE /api/v1/conversations/[id]/scheduled-messages/[msgId] — cancela mensagem pendente.
 *
 * Invariante de Concorrência: Não permite alteração ou cancelamento de mensagens
 * cujo status já não seja 'pending' (ex: após claim pelo worker com status 'processing' ou já enviadas).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { patchScheduledMessageSchema } from "@/lib/schemas/scheduled-messages";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; msgId: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id: conversationId, msgId } = await params;

  const supabase = await createClient();

  const { data: existing, error: findErr } = await supabase
    .from("scheduled_messages")
    .select("*")
    .eq("id", msgId)
    .eq("conversation_id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (findErr) {
    return fail("internal_error", t("Erro ao consultar mensagem programada."), 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", t("Mensagem programada não encontrada."), 404, { requestId });
  }

  // Trava de segurança: apenas mensagens pendentes podem ser editadas ou reagendadas
  if (existing.status !== "pending") {
    return fail(
      "invalid_state",
      t("Esta mensagem não pode ser alterada porque já está em processamento ou finalizada."),
      409,
      { requestId }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo JSON inválido."), 400, { requestId });
  }

  const parsed = patchScheduledMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const updates: Record<string, unknown> = {};

  if (parsed.data.scheduled_for !== undefined) {
    const scheduledTime = new Date(parsed.data.scheduled_for).getTime();
    if (scheduledTime < Date.now() - 30_000) {
      return fail(
        "validation_failed",
        t("O horário de agendamento deve ser no futuro."),
        422,
        { requestId }
      );
    }
    updates.scheduled_for = parsed.data.scheduled_for;
  }

  if (parsed.data.body !== undefined) {
    updates.body = parsed.data.body ? parsed.data.body.trim() : null;
  }

  if (parsed.data.media_storage_path !== undefined) {
    if (parsed.data.media_storage_path) {
      if (!isMediaPathOwnedBy(parsed.data.media_storage_path, org.orgId, conversationId)) {
        return fail(
          "forbidden",
          t("Caminho de mídia inválido ou não pertencente a esta organização."),
          403,
          { requestId }
        );
      }
    }
    updates.media_storage_path = parsed.data.media_storage_path || null;
  }

  if (parsed.data.media_type !== undefined) {
    updates.media_type = parsed.data.media_type || null;
  }
  if (parsed.data.media_mime !== undefined) {
    updates.media_mime = parsed.data.media_mime || null;
  }
  if (parsed.data.media_filename !== undefined) {
    updates.media_filename = parsed.data.media_filename || null;
  }
  if (parsed.data.caption !== undefined) {
    updates.caption = parsed.data.caption ? parsed.data.caption.trim() : null;
  }

  // Verifica se o resultado final mantém pelo menos body ou media_storage_path
  const finalBody = updates.body !== undefined ? updates.body : existing.body;
  const finalMedia = updates.media_storage_path !== undefined ? updates.media_storage_path : existing.media_storage_path;
  if (!finalBody && !finalMedia) {
    return fail("validation_failed", t("A mensagem não pode ficar sem texto e sem anexo."), 422, { requestId });
  }

  const { data: updated, error: updErr } = await supabase
    .from("scheduled_messages")
    .update(updates)
    .eq("id", msgId)
    .eq("organization_id", org.orgId)
    .eq("status", "pending") // Defesa adicional contra disputa concorrente
    .select("*")
    .maybeSingle();

  if (updErr || !updated) {
    return fail(
      "conflict",
      t("Não foi possível atualizar a mensagem. Ela pode ter entrado em processamento."),
      409,
      { requestId }
    );
  }

  audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "scheduled_message.updated",
    resourceType: "scheduled_message",
    resourceId: msgId,
    requestId,
    metadata: {
      conversation_id: conversationId,
      updates,
    },
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1",
  });

  return ok(updated, { requestId });
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id: conversationId, msgId } = await params;

  const supabase = await createClient();

  const { data: existing, error: findErr } = await supabase
    .from("scheduled_messages")
    .select("id, status")
    .eq("id", msgId)
    .eq("conversation_id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (findErr) {
    return fail("internal_error", t("Erro ao consultar mensagem programada."), 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", t("Mensagem programada não encontrada."), 404, { requestId });
  }

  if (existing.status !== "pending") {
    return fail(
      "invalid_state",
      t("Esta mensagem não pode ser cancelada porque já está em processamento ou finalizada."),
      409,
      { requestId }
    );
  }

  const { data: cancelled, error: updErr } = await supabase
    .from("scheduled_messages")
    .update({ status: "cancelled" })
    .eq("id", msgId)
    .eq("organization_id", org.orgId)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle();

  if (updErr || !cancelled) {
    return fail(
      "conflict",
      t("Não foi possível cancelar a mensagem. Ela pode ter entrado em processamento."),
      409,
      { requestId }
    );
  }

  audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "scheduled_message.cancelled",
    resourceType: "scheduled_message",
    resourceId: msgId,
    requestId,
    metadata: { conversation_id: conversationId },
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1",
  });

  return ok({ cancelled: true, id: msgId }, { requestId });
}

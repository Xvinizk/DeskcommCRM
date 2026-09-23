import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/conversations/[id]/scheduled-messages — lista mensagens agendadas da conversa.
 * POST /api/v1/conversations/[id]/scheduled-messages — agenda nova mensagem (texto, imagem, vídeo ou áudio).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createScheduledMessageSchema } from "@/lib/schemas/scheduled-messages";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id: conversationId } = await params;

  const supabase = await createClient();

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (!conv) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status") || "pending";

  let query = supabase
    .from("scheduled_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("organization_id", org.orgId);

  if (statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query.order("scheduled_for", { ascending: true });

  if (error) {
    return fail("internal_error", t("Erro ao listar mensagens programadas."), 500, { requestId });
  }

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id: conversationId } = await params;

  const supabase = await createClient();

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (!conv) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo JSON inválido."), 400, { requestId });
  }

  const parsed = createScheduledMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const {
    scheduled_for,
    body,
    media_storage_path,
    media_type,
    media_mime,
    media_filename,
    caption,
  } = parsed.data;

  // Validação temporal: deve ser no futuro (tolerância de 30s para atrasos de rede)
  const scheduledTime = new Date(scheduled_for).getTime();
  if (scheduledTime < Date.now() - 30_000) {
    return fail(
      "validation_failed",
      t("O horário de agendamento deve ser no futuro."),
      422,
      { requestId }
    );
  }

  // Validação de posse do arquivo de mídia sob o bucket do tenant
  if (media_storage_path) {
    if (!isMediaPathOwnedBy(media_storage_path, org.orgId, conversationId)) {
      return fail(
        "forbidden",
        t("Caminho de mídia inválido ou não pertencente a esta organização."),
        403,
        { requestId }
      );
    }
  }

  const insertPayload = {
    organization_id: org.orgId,
    conversation_id: conversationId,
    created_by: user.id,
    scheduled_for,
    body: body?.trim() || null,
    media_storage_path: media_storage_path || null,
    media_type: media_type || null,
    media_mime: media_mime || null,
    media_filename: media_filename || null,
    caption: caption?.trim() || null,
    status: "pending",
  };

  const { data: created, error: insErr } = await supabase
    .from("scheduled_messages")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insErr || !created) {
    return fail("internal_error", t("Erro ao salvar mensagem programada."), 500, { requestId });
  }

  audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "scheduled_message.created",
    resourceType: "scheduled_message",
    resourceId: created.id,
    requestId,
    metadata: {
      conversation_id: conversationId,
      scheduled_for,
      has_media: Boolean(media_storage_path),
      media_type,
    },
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1",
  });

  return ok(created, { requestId });
}

import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/media — upload de mídia para nós do Flow Builder.
 * Bucket: whatsapp-media (privado)
 * Path: ${organizationId}/flows/${randomUUID()}.${ext}
 *
 * GET /api/v1/ai/followup-flows/media?path=... — resolve signed URL temporária
 * para preview na tela (302 redirect ou JSON com ?format=json).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const activeOrg = { orgId: authz.org.orgId };

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES + 1_048_576) {
    return fail("payload_too_large", t("Arquivo acima de 50MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  // Escopo de mídia restrito: apenas image, video, audio (sem document nesta versão)
  if (verdict.kind !== "image" && verdict.kind !== "video" && verdict.kind !== "audio") {
    return fail("unsupported_media_type", t("Tipo de arquivo não suportado. Permitidos: imagem, vídeo ou áudio."), 415, { requestId });
  }

  const bruto = Buffer.from(await file.arrayBuffer());

  let mimeFinal = mime;
  let buffer: Buffer = bruto;

  if (verdict.kind === "audio") {
    const audio = await transcodificarNotaDeVoz({ buffer: bruto, mime });
    mimeFinal = audio.mime;
    buffer = audio.buffer;
  }

  const ext = extFromMime(mimeFinal);
  const storagePath = `${activeOrg.orgId}/flows/${randomUUID()}.${ext}`;

  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mimeFinal, upsert: false });

  if (upErr) {
    logger.error("[followup-flows/media] upload falhou", { detail: upErr.message, requestId });
    return fail("internal_error", t("Erro ao subir arquivo de mídia."), 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      media_type: verdict.kind,
      media_mime: mimeFinal,
      media_size_bytes: buffer.length,
      media_filename: file.name,
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;

  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return fail("validation_failed", t("Parâmetro 'path' obrigatório."), 422, { requestId });
  }

  // Isolamento tenant-aware: o caminho deve obrigatoriamente pertencer aos fluxos da organização ativa
  if (!path.startsWith(`${authz.org.orgId}/flows/`)) {
    return fail("forbidden", t("Acesso não autorizado ao arquivo."), 403, { requestId });
  }

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from("whatsapp-media")
    .createSignedUrl(path, 3600); // 1 hora de validade para visualização na UI

  if (signErr || !signed?.signedUrl) {
    return fail("not_found", t("Arquivo não encontrado."), 404, { requestId });
  }

  if (url.searchParams.get("format") === "json") {
    return ok({ signed_url: signed.signedUrl }, { requestId });
  }

  const response = NextResponse.redirect(signed.signedUrl, 302);
  response.headers.set("X-Request-Id", requestId);
  return response;
}

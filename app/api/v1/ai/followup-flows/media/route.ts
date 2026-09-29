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

  let fileBlob: Blob | null = null;
  let fileName = "media";
  let mime = "";

  const reqClone = req.clone();
  const form = await req.formData().catch((err) => {
    logger.warn("[followup-flows/media] req.formData falhou, usando fallback multipart", {
      err: String(err),
      requestId,
    });
    return null;
  });

  if (form) {
    const file = form.get("file");
    if (file && typeof file === "object" && typeof (file as Blob).arrayBuffer === "function") {
      fileBlob = file as Blob;
      fileName = (file as { name?: string }).name || "media";
      mime = fileBlob.type || "";
    }
  }

  if (!fileBlob) {
    try {
      const rawBuffer = Buffer.from(await reqClone.arrayBuffer());
      const contentType = req.headers.get("content-type") || "";
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
      const rawBoundary = boundaryMatch?.[1];
      if (rawBoundary) {
        const boundary = rawBoundary.trim().replace(/^["']|["']$/g, "");
        const rawStr = rawBuffer.toString("binary");
        const parts = rawStr.split(`--${boundary}`);
        for (const part of parts) {
          if (part.includes('name="file"') || part.includes("name='file'")) {
            const headerEnd = part.indexOf("\r\n\r\n");
            if (headerEnd !== -1) {
              const headerStr = part.slice(0, headerEnd);
              const fnMatch = headerStr.match(/filename=["']?([^"';\r\n]+)/i);
              if (fnMatch?.[1]) fileName = fnMatch[1].trim();
              const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
              if (ctMatch?.[1]) mime = ctMatch[1].trim();

              let bodyStr = part.slice(headerEnd + 4);
              if (bodyStr.endsWith("\r\n")) {
                bodyStr = bodyStr.slice(0, -2);
              }
              const fileBuf = Buffer.from(bodyStr, "binary");
              fileBlob = new Blob([fileBuf], { type: mime });
              break;
            }
          }
        }
      }
    } catch {
      // Falha silenciosa no fallback
    }
  }

  if (!fileBlob) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }
  if (!mime || mime === "application/octet-stream") {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext === "mp4") mime = "video/mp4";
    else if (ext === "mov") mime = "video/quicktime";
    else if (ext === "webm") mime = "video/webm";
    else if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
    else if (ext === "png") mime = "image/png";
    else if (ext === "webp") mime = "image/webp";
    else if (ext === "gif") mime = "image/gif";
    else if (ext === "mp3") mime = "audio/mpeg";
    else if (ext === "ogg") mime = "audio/ogg";
    else if (ext === "wav") mime = "audio/wav";
    else mime = "application/octet-stream";
  }

  const verdict = validateOutboundMedia(mime, fileBlob.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  // Escopo de mídia restrito: apenas image, video, audio (sem document nesta versão)
  if (verdict.kind !== "image" && verdict.kind !== "video" && verdict.kind !== "audio") {
    return fail("unsupported_media_type", t("Tipo de arquivo não suportado. Permitidos: imagem, vídeo ou áudio."), 415, { requestId });
  }

  const bruto = Buffer.from(await fileBlob.arrayBuffer());

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
      media_filename: fileName,
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

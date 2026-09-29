import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extFromMime } from "@/lib/messaging/media/types";
import { logger } from "@/lib/logger";

export interface DuplicateMediaResult {
  ok: boolean;
  newStoragePath?: string;
  error?: string;
}

/**
 * Duplica uma mídia do bucket whatsapp-media para o namespace da organização de destino.
 * Desta forma a conta que importou o Fluxo fica completamente independente da organização de origem.
 */
export async function duplicateFlowMedia(
  admin: SupabaseClient,
  params: {
    sourceStoragePath: string;
    targetOrgId: string;
    mime?: string;
  },
): Promise<DuplicateMediaResult> {
  const { sourceStoragePath, targetOrgId, mime = "application/octet-stream" } = params;

  if (!sourceStoragePath) {
    return { ok: false, error: "Caminho de origem não fornecido." };
  }

  const ext = extFromMime(mime);
  const destPath = `${targetOrgId}/flows/${randomUUID()}.${ext}`;

  try {
    // 1. Tentar cópia direta no bucket do Storage
    const { error: copyErr } = await admin.storage
      .from("whatsapp-media")
      .copy(sourceStoragePath, destPath);

    if (!copyErr) {
      return { ok: true, newStoragePath: destPath };
    }

    // 2. Fallback: download do blob e re-upload para o novo namespace
    const { data: blob, error: dlErr } = await admin.storage
      .from("whatsapp-media")
      .download(sourceStoragePath);

    if (dlErr || !blob) {
      logger.warn("[duplicateFlowMedia] falha no download da mídia original", {
        sourceStoragePath,
        error: dlErr?.message,
      });
      return {
        ok: false,
        error: dlErr?.message || "Arquivo original inacessível.",
      };
    }

    const buffer = Buffer.from(await blob.arrayBuffer());
    const { error: upErr } = await admin.storage
      .from("whatsapp-media")
      .upload(destPath, buffer, { contentType: mime, upsert: false });

    if (upErr) {
      logger.warn("[duplicateFlowMedia] falha no upload da cópia da mídia", {
        destPath,
        error: upErr?.message,
      });
      return {
        ok: false,
        error: upErr?.message || "Falha ao gravar mídia na organização de destino.",
      };
    }

    return { ok: true, newStoragePath: destPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("[duplicateFlowMedia] erro inesperado ao duplicar mídia", {
      sourceStoragePath,
      destPath,
      err: msg,
    });
    return { ok: false, error: msg };
  }
}

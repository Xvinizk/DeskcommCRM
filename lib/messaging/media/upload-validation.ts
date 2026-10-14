/** Validação do upload outbound (Onda 2). Allowlist por categoria + cap 50MB. */
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

export type MessageKind = "image" | "video" | "audio" | "document";

/**
 * Posse do objeto no bucket: o path DEVE estar sob {org}/{conversation}/
 * (chaves do Storage são literais — sem semântica de traversal).
 *
 * Morava dentro do módulo de transporte do provider legado e não tinha nada a
 * ver com o canal: valida um path do NOSSO Storage, antes de qualquer coisa
 * tocar um provider. Ficar lá obrigava o handler de envio a importar do módulo
 * do provider — o acoplamento que o invariante 1 de
 * `docs/doctrine/restricao-de-canal.md` proíbe.
 */
export function isMediaPathOwnedBy(path: string, orgId: string, conversationId: string): boolean {
  if (path.startsWith(`${orgId}/${conversationId}/`)) return true;
  if (path.startsWith(`${orgId}/flows/`)) return true;
  if (path.startsWith(`${orgId}/templates/`)) return true;
  if (path.startsWith(`${orgId}/assets/`)) return true;
  return false;
}

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);

type Ok = { ok: true; kind: MessageKind };
type Fail = { ok: false; code: "unsupported_media_type" | "payload_too_large" | "validation_failed"; message: string };

export function validateOutboundMedia(mime: string, sizeBytes: number): Ok | Fail {
  if (!sizeBytes || sizeBytes <= 0) {
    return { ok: false, code: "validation_failed", message: "Arquivo vazio." };
  }
  if (sizeBytes > MAX_MEDIA_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Arquivo acima de 50MB." };
  }
  const base = mime.split(";")[0]!.trim().toLowerCase();
  if (base.startsWith("image/")) return { ok: true, kind: "image" };
  if (base.startsWith("video/")) return { ok: true, kind: "video" };
  if (base.startsWith("audio/")) return { ok: true, kind: "audio" };
  if (DOCUMENT_MIMES.has(base)) return { ok: true, kind: "document" };
  return { ok: false, code: "unsupported_media_type", message: "Tipo de arquivo não suportado." };
}

/**
 * Inspeciona a integridade de um container MP4 verificando se átomos de mídia
 * (mdat) não declaram tamanho superior aos bytes realmente contidos no buffer.
 * Evita upload e persistência de vídeos truncados cujo cabeçalho (moov) promete
 * uma duração maior (ex.: 59s) do que os pacotes de mídia realmente gravados (ex.: 24s).
 */
export function validateMp4BufferIntegrity(buffer: Buffer): { ok: true } | { ok: false; reason: string } {
  if (buffer.length < 16) return { ok: true };
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      const extSize = Number(buffer.readBigUInt64BE(offset + 8));
      size = extSize;
      headerSize = 16;
    } else if (size === 0) {
      break;
    }
    if (size < headerSize) break;
    if (type === "mdat") {
      if (offset + size > buffer.length) {
        return {
          ok: false,
          reason: `Arquivo de vídeo truncado (bloco mdat declara ${size} bytes mas o arquivo só possui ${buffer.length - offset} bytes restantes).`,
        };
      }
    }
    offset += size;
  }
  return { ok: true };
}


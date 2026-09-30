import type pg from 'pg';
import type { AiNodeSessionMediaSummary } from './ai-node-session';

export interface RawMediaMessage {
  id: string;
  type?: string | null;
  media_mime?: string | null;
  direction?: string | null;
  created_at?: string | Date | null;
  sent_at?: string | Date | null;
}

/**
 * Agrega mídias de mensagens recebidas de forma puramente determinística.
 * - Filtra apenas mensagens inbound recebidas a partir de `startedAt`.
 * - Deduplica mensagens por `id` para evitar contagem dupla em retries.
 * - Não usa LLM nem inferência textual.
 */
export function aggregateAiNodeMedia(
  messages: RawMediaMessage[],
  startedAt: string | Date,
): AiNodeSessionMediaSummary {
  const startedAtMs = new Date(startedAt).getTime();

  let imagesCount = 0;
  let audiosCount = 0;
  let documentsCount = 0;
  const mediaIds: string[] = [];

  // Deduplicação estrita por message.id
  const seenIds = new Set<string>();

  // Ordena cronologicamente por sent_at/created_at
  const sorted = [...messages].sort((a, b) => {
    const timeA = new Date(a.sent_at ?? a.created_at ?? 0).getTime();
    const timeB = new Date(b.sent_at ?? b.created_at ?? 0).getTime();
    return timeA - timeB;
  });

  for (const msg of sorted) {
    if (!msg.id || seenIds.has(msg.id)) {
      continue;
    }
    seenIds.add(msg.id);

    // Considera apenas inbound (ou omitido se a fonte já pré-filtrar por inbound)
    if (msg.direction && msg.direction !== 'inbound') {
      continue;
    }

    const msgTime = new Date(msg.sent_at ?? msg.created_at ?? 0).getTime();
    if (isNaN(msgTime) || msgTime < startedAtMs) {
      continue;
    }

    const type = (msg.type ?? '').toLowerCase();
    const mime = (msg.media_mime ?? '').toLowerCase();

    const isImage = type === 'image' || mime.startsWith('image/');
    const isAudio = type === 'audio' || type === 'voice' || mime.startsWith('audio/');
    const isDoc =
      type === 'document' ||
      type === 'file' ||
      mime.startsWith('application/') ||
      mime.startsWith('text/');

    let hasMedia = false;

    if (isImage) {
      imagesCount++;
      hasMedia = true;
    } else if (isAudio) {
      audiosCount++;
      hasMedia = true;
    } else if (isDoc) {
      documentsCount++;
      hasMedia = true;
    }

    if (hasMedia && !mediaIds.includes(msg.id)) {
      mediaIds.push(msg.id);
    }
  }

  return {
    images_count: imagesCount,
    audios_count: audiosCount,
    documents_count: documentsCount,
    last_media_ids: mediaIds,
  };
}

/**
 * Carrega mensagens da conversa a partir de `startedAt` e agrega as mídias.
 */
export async function fetchAndAggregateAiNodeMedia(
  db: pg.Pool,
  organizationId: string,
  conversationId: string,
  startedAt: string | Date,
): Promise<AiNodeSessionMediaSummary> {
  const { rows } = await db.query<RawMediaMessage>(
    `SELECT id, type, media_mime, direction, created_at, sent_at
     FROM messages
     WHERE organization_id = $1
       AND conversation_id = $2
       AND direction = 'inbound'
       AND COALESCE(sent_at, created_at) >= $3
     ORDER BY COALESCE(sent_at, created_at) ASC, id ASC`,
    [organizationId, conversationId, new Date(startedAt).toISOString()],
  );

  return aggregateAiNodeMedia(rows, startedAt);
}

import { describe, expect, it } from 'vitest';
import { aggregateAiNodeMedia, type RawMediaMessage } from '@/lib/followup/ai-node-media';

describe('ai-node-media-aggregation', () => {
  const sessionStartedAt = '2026-09-30T14:00:00.000Z';

  it('contabiliza imagens por type ou media_mime', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-img-1',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:05:00.000Z',
      },
      {
        id: 'msg-img-2',
        type: 'chat',
        media_mime: 'image/png',
        direction: 'inbound',
        sent_at: '2026-09-30T14:06:00.000Z',
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(2);
    expect(summary.audios_count).toBe(0);
    expect(summary.documents_count).toBe(0);
    expect(summary.last_media_ids).toEqual(['msg-img-1', 'msg-img-2']);
  });

  it('contabiliza áudios por type audio/voice ou media_mime audio/*', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-aud-1',
        type: 'audio',
        media_mime: 'audio/ogg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:10:00.000Z',
      },
      {
        id: 'msg-aud-2',
        type: 'voice',
        media_mime: 'audio/mp4',
        direction: 'inbound',
        sent_at: '2026-09-30T14:11:00.000Z',
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(0);
    expect(summary.audios_count).toBe(2);
    expect(summary.documents_count).toBe(0);
    expect(summary.last_media_ids).toEqual(['msg-aud-1', 'msg-aud-2']);
  });

  it('contabiliza documentos por type document/file ou media_mime application/* / text/*', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-doc-1',
        type: 'document',
        media_mime: 'application/pdf',
        direction: 'inbound',
        sent_at: '2026-09-30T14:15:00.000Z',
      },
      {
        id: 'msg-doc-2',
        type: 'file',
        media_mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        direction: 'inbound',
        sent_at: '2026-09-30T14:16:00.000Z',
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(0);
    expect(summary.audios_count).toBe(0);
    expect(summary.documents_count).toBe(2);
    expect(summary.last_media_ids).toEqual(['msg-doc-1', 'msg-doc-2']);
  });

  it('contabiliza fluxo misto com múltiplas mídias e textos simples', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-1',
        type: 'text',
        direction: 'inbound',
        sent_at: '2026-09-30T14:01:00.000Z',
      },
      {
        id: 'msg-2',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:02:00.000Z',
      },
      {
        id: 'msg-3',
        type: 'voice',
        media_mime: 'audio/ogg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:03:00.000Z',
      },
      {
        id: 'msg-4',
        type: 'document',
        media_mime: 'application/pdf',
        direction: 'inbound',
        sent_at: '2026-09-30T14:04:00.000Z',
      },
      {
        id: 'msg-5',
        type: 'text',
        direction: 'inbound',
        sent_at: '2026-09-30T14:05:00.000Z',
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(1);
    expect(summary.audios_count).toBe(1);
    expect(summary.documents_count).toBe(1);
    expect(summary.last_media_ids).toEqual(['msg-2', 'msg-3', 'msg-4']);
  });

  it('ignora mensagens anteriores ao started_at da sessão', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-old-img',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'inbound',
        sent_at: '2026-09-30T13:59:59.000Z', // 1 segundo antes do started_at
      },
      {
        id: 'msg-new-img',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:00:01.000Z', // após started_at
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(1);
    expect(summary.last_media_ids).toEqual(['msg-new-img']);
  });

  it('ignora mensagens outbound enviadas pelo bot ou atendente', () => {
    const messages: RawMediaMessage[] = [
      {
        id: 'msg-out-img',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'outbound',
        sent_at: '2026-09-30T14:05:00.000Z',
      },
      {
        id: 'msg-in-img',
        type: 'image',
        media_mime: 'image/jpeg',
        direction: 'inbound',
        sent_at: '2026-09-30T14:06:00.000Z',
      },
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(1);
    expect(summary.last_media_ids).toEqual(['msg-in-img']);
  });

  it('retry da mesma mensagem física NÃO duplica contagem (deduplicação por ID)', () => {
    const duplicateMessage: RawMediaMessage = {
      id: 'msg-retry-fixed-id',
      type: 'image',
      media_mime: 'image/jpeg',
      direction: 'inbound',
      sent_at: '2026-09-30T14:10:00.000Z',
    };

    // A mesma mensagem repetida 5 vezes
    const messages: RawMediaMessage[] = [
      duplicateMessage,
      duplicateMessage,
      duplicateMessage,
      duplicateMessage,
      duplicateMessage,
    ];

    const summary = aggregateAiNodeMedia(messages, sessionStartedAt);
    expect(summary.images_count).toBe(1); // Exatamente 1, não 5!
    expect(summary.last_media_ids).toEqual(['msg-retry-fixed-id']);
  });
});

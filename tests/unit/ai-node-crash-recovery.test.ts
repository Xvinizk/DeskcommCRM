import { describe, expect, it } from 'vitest';
import {
  acquireAiNodeInboundTurn,
  completeAiNodeInboundTurn,
  recordAiNodeReplyGenerated,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import { createMockDb } from './ai-node-idempotency.test';

describe('ai-node-crash-recovery', () => {
  it('Crash após claim/commit e antes da chamada de modelo: retry retoma (resumed) sem perder a mensagem', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment, getEvents } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-inbound-crash-test';

    // 1. Worker faz claim com sucesso
    const step1 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId,
      messageSentAt: '2026-09-30T12:01:00Z',
    });

    expect(step1.status).toBe('acquired');
    if (step1.status === 'acquired') {
      expect(step1.is_retry).toBe(false);
      expect(step1.turn_count).toBe(1);
    }
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // 2. SIMULAÇÃO DE CRASH: O worker cai neste exato instante (antes do LLM).
    // Nenhum completeAiNodeInboundTurn foi chamado.

    // 3. Worker reinicia e recebe o mesmo job/mensagem via retry:
    const step2 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId,
      messageSentAt: '2026-09-30T12:01:00Z',
    });

    // 4. Deve RETOMAR (resumed) em vez de ser descartado silenciosamente como already_processed!
    expect(step2.status).toBe('resumed');
    if (step2.status === 'resumed') {
      expect(step2.is_retry).toBe(true);
      // turn_count NÃO foi duplicado (permanece 1)
      expect(step2.turn_count).toBe(1);
    }
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // 5. Agora o worker executa o modelo, envia a resposta e CONCLUI o turno:
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
      outboundMessageId: 'msg-outbound-reply-1',
    });

    // 6. Novo retry tardio pós-conclusão: agora sim vira no-op 'completed'!
    const step3 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId,
    });
    expect(step3.status).toBe('completed');
    if (step3.status === 'completed') {
      expect(step3.is_retry).toBe(true);
    }

    // turn_count permanece intacto
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
    expect(getEvents().filter((e) => e.event_type === 'ai_node.turn_completed')).toHaveLength(1);
  });

  it('5 entregas concorrentes: apenas UMA cadeia lógica inicializa e turn_count vira 1', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-concorrente-5x';

    // Dispara 5 chamadas simultâneas
    const promises = Array.from({ length: 5 }).map(() =>
      acquireAiNodeInboundTurn(mockDb, {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        messageSentAt: '2026-09-30T12:02:00Z',
      }),
    );

    const results = await Promise.all(promises);

    // Exatamente UMA deve ter status 'acquired' (claim inédito)
    const acquiredList = results.filter((r) => r.status === 'acquired');
    expect(acquiredList).toHaveLength(1);

    // As outras 4 devem ter status 'resumed' (já em voo)
    const resumedList = results.filter((r) => r.status === 'resumed');
    expect(resumedList).toHaveLength(4);

    // O turn_count final DEVE ser exatamente 1, nunca 5!
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
  });

  it('Monotonicidade de last_inbound_at: mensagem atrasada ou retry antigo NUNCA regride o relógio', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 1,
      started_at: '2026-09-30T12:00:00Z',
      last_inbound_at: '2026-09-30T12:30:00.000Z', // Já está às 12:30
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    // Chega uma mensagem inbound inédita, porém com timestamp atrasado de 12:15 (anterior a 12:30)
    const res = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-atrasada-1215',
      messageSentAt: '2026-09-30T12:15:00.000Z',
    });

    expect(res.status).toBe('acquired');
    // last_inbound_at NUNCA regride: GREATEST(12:30, 12:15) = 12:30
    expect(getEnrollment().ai_node_session?.last_inbound_at).toBe('2026-09-30T12:30:00.000Z');

    // Agora chega uma mensagem mais recente (12:45)
    await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-recente-1245',
      messageSentAt: '2026-09-30T12:45:00.000Z',
    });

    // Atualiza para o horário mais novo
    expect(getEnrollment().ai_node_session?.last_inbound_at).toBe('2026-09-30T12:45:00.000Z');
  });

  it('Proteção contra custo de LLM duplicado (Caso D): resposta persistida é preservada', async () => {
    const { mockDb, getEvents } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: {
        node_id: 'node-ai-1',
        flow_id: 'flow-1',
        mode: 'existing_agent',
        status: 'running',
        turn_count: 0,
        started_at: '2026-09-30T12:00:00Z',
        media_summary: {
          images_count: 0,
          audios_count: 0,
          documents_count: 0,
          last_media_ids: [],
        },
      },
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-llm-crash-test';

    // 1. Grava resposta gerada pelo LLM antes do outbound
    const recordResult = await recordAiNodeReplyGenerated(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
      replyText: 'Olá! Como posso ajudar com sua consulta?',
      tokensIn: 150,
      tokensOut: 20,
    });
    expect(recordResult.recorded).toBe(true);

    // 2. Se o processo cair antes do envio e tentar gravar novamente no retry:
    // A chave de idempotência ai_node_reply:... impede duplicata
    const retryRecord = await recordAiNodeReplyGenerated(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
      replyText: 'Texto duplicado que não deve ser gravado',
    });
    expect(retryRecord.recorded).toBe(false);

    // Apenas uma resposta do LLM está registrada
    const replyEvents = getEvents().filter((e) => e.event_type === 'ai_node.reply_generated');
    expect(replyEvents).toHaveLength(1);
    expect((replyEvents[0]?.payload as { reply_text: string }).reply_text).toBe('Olá! Como posso ajudar com sua consulta?');
  });
});

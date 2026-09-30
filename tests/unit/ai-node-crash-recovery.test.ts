import { describe, expect, it } from 'vitest';
import {
  acquireAiNodeInboundTurn,
  completeAiNodeInboundTurn,
  recordAiNodeReplyGenerated,
  getAiNodeGeneratedReply,
  resolveAiNodeOutboundRecovery,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import { createMockDb } from './ai-node-idempotency.test';

const defaultMediaSummary = {
  images_count: 0,
  audios_count: 0,
  documents_count: 0,
  last_media_ids: [],
};

describe('ai-node-crash-recovery: lease, ownership e concorrência', () => {
  it('CASO A: 5 entregas simultâneas da mesma mensagem -> exatamente 1 acquired, 4 in_progress, ZERO resumed', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
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
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 5 workers disparando ao mesmo tempo para a mesma mensagem física
    const promises = Array.from({ length: 5 }).map((_, i) =>
      acquireAiNodeInboundTurn(
        mockDb,
        {
          organizationId: 'org-1',
          enrollmentId: 'enrollment-1',
          expectedNodeId: 'node-ai-1',
          inboundMessageId,
          messageSentAt: '2026-09-30T12:00:00Z',
          workerId: `worker-conc-${i + 1}`,
          leaseDurationMs: 60_000,
        },
        { clock: () => t0 },
      ),
    );

    const results = await Promise.all(promises);

    // 1. Exatamente UMA deve ter status 'acquired'
    const acquiredList = results.filter((r) => r.status === 'acquired');
    expect(acquiredList).toHaveLength(1);

    // 2. As outras 4 DEVEM ter status 'in_progress' (NÃO podem chamar LLM!)
    const inProgressList = results.filter((r) => r.status === 'in_progress');
    expect(inProgressList).toHaveLength(4);

    // 3. ZERO resumed enquanto a lease inicial está ativa
    const resumedList = results.filter((r) => r.status === 'resumed');
    expect(resumedList).toHaveLength(0);

    // 4. turn_count final DEVE ser exatamente 1, nunca 5!
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
  });

  it('CASO B: claim existente e worker ainda dentro da lease -> retry retorna in_progress', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-lease-active';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Worker A adquire claim com lease de 60s (válido até 12:01:00)
    const claimA = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseDurationMs: 60_000,
      },
      { clock: () => t0 },
    );
    expect(claimA.status).toBe('acquired');

    // Worker B chega 15s depois (12:00:15)
    const t1 = new Date('2026-09-30T12:00:15Z');
    const retryB = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-B',
      },
      { clock: () => t1 },
    );

    // Worker B é barrado com in_progress
    expect(retryB.status).toBe('in_progress');
    if (retryB.status === 'in_progress') {
      expect(retryB.worker_id).toBe('worker-A');
      expect(retryB.lease_until).toBe('2026-09-30T12:01:00.000Z');
    }

    // turn_count permanece 1
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
  });

  it('CASO C: claim existente e lease expirou -> retry consegue takeover (resumed) sem duplicar turn_count', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEnrollment, getEvents } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-takeover-test';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 1. Worker A faz claim com lease de 60s (até 12:01:00)
    const step1 = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseDurationMs: 60_000,
      },
      { clock: () => t0 },
    );
    expect(step1.status).toBe('acquired');

    // 2. SIMULAÇÃO DE CRASH: Worker A morre. Tempo avança além da lease (12:01:05).
    const tExpired = new Date('2026-09-30T12:01:05Z');

    // 3. Worker B chega para takeover
    const step2 = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-B',
        leaseDurationMs: 60_000,
      },
      { clock: () => tExpired },
    );

    expect(step2.status).toBe('resumed');
    if (step2.status === 'resumed') {
      expect(step2.is_retry).toBe(true);
      expect(step2.turn_count).toBe(1); // turn_count NÃO incrementado
      expect(step2.worker_id).toBe('worker-B');
      expect(step2.lease_until).toBe('2026-09-30T12:02:05.000Z');
    }

    // Registrou evento de takeover auditável
    const takeovers = getEvents().filter((e) => e.event_type === 'ai_node.claim_takeover');
    expect(takeovers).toHaveLength(1);
    const takeoverPayload = takeovers[0]!.payload as { previous_worker_id: string; new_worker_id: string };
    expect(takeoverPayload.previous_worker_id).toBe('worker-A');
    expect(takeoverPayload.new_worker_id).toBe('worker-B');

    // turn_count permanece 1
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
  });

  it('CASO D: reply cache já existe após crash -> resumed recupera resposta salva sem chamar LLM', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-reply-cache-recovery';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 1. Worker A claima
    await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseDurationMs: 60_000,
      },
      { clock: () => t0 },
    );

    // 2. Worker A chama LLM e grava reply cache antes de morrer
    const recordResult = await recordAiNodeReplyGenerated(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        replyText: 'Olá! Como posso ajudar você hoje?',
        tokensIn: 120,
        tokensOut: 25,
      },
      { clock: () => t0 },
    );
    expect(recordResult.recorded).toBe(true);

    // 3. Worker A morre. Lease expira.
    const tExpired = new Date('2026-09-30T12:01:10Z');

    // 4. Worker B assume
    const resumeResult = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-B',
      },
      { clock: () => tExpired },
    );
    expect(resumeResult.status).toBe('resumed');

    // 5. Worker B recupera a resposta do cache -> NÃO precisa chamar LLM
    const cachedReply = await getAiNodeGeneratedReply(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
    });
    expect(cachedReply).not.toBeNull();
    expect(cachedReply?.reply_text).toBe('Olá! Como posso ajudar você hoje?');
    expect(cachedReply?.tokens_in).toBe(120);
    expect(cachedReply?.tokens_out).toBe(25);
  });

  it('CASO E: completed existe -> retries viram completed/no-op', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-completed-test';
    const t0 = new Date('2026-09-30T12:00:00Z');

    await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
      },
      { clock: () => t0 },
    );

    // Conclui formalmente
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
      outboundMessageId: 'out-1',
    });

    // 3 tentativas subsequentes
    for (let i = 1; i <= 3; i++) {
      const retry = await acquireAiNodeInboundTurn(
        mockDb,
        {
          organizationId: 'org-1',
          enrollmentId: 'enrollment-1',
          expectedNodeId: 'node-ai-1',
          inboundMessageId,
        },
        { clock: () => new Date('2026-09-30T12:30:00Z') },
      );
      expect(retry.status).toBe('completed');
    }

    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
    expect(getEnrollment().ai_node_session?.active_turn).toBeNull();
  });

  it('CASO F: 20 concorrentes tentando assumir claim expirado -> exatamente 1 ganha takeover e 19 ficam in_progress', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-20-workers-expired';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 1. Initial claim com lease de 60s
    await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-dead',
        leaseDurationMs: 60_000,
      },
      { clock: () => t0 },
    );

    // 2. Tempo avança para 12:01:05 (lease expirou)
    const tExpired = new Date('2026-09-30T12:01:05Z');

    // 3. 20 workers simultâneos tentando assumir o claim expirado
    const promises = Array.from({ length: 20 }).map((_, i) =>
      acquireAiNodeInboundTurn(
        mockDb,
        {
          organizationId: 'org-1',
          enrollmentId: 'enrollment-1',
          expectedNodeId: 'node-ai-1',
          inboundMessageId,
          workerId: `worker-takeover-${i + 1}`,
          leaseDurationMs: 60_000,
        },
        { clock: () => tExpired },
      ),
    );

    const results = await Promise.all(promises);

    // Exatamente 1 deve ser 'resumed' (ganhou o takeover atômico)
    const resumedList = results.filter((r) => r.status === 'resumed');
    expect(resumedList).toHaveLength(1);

    // Os outros 19 devem ser 'in_progress' (viram que o novo worker já renovou a lease)
    const inProgressList = results.filter((r) => r.status === 'in_progress');
    expect(inProgressList).toHaveLength(19);

    // turn_count permanece exatamente 1!
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
      last_inbound_at: '2026-09-30T12:05:00.000Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    // Mensagem com timestamp MAIS NOVO (12:07:00) -> Atualiza last_inbound_at
    const res1 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-nova-1',
      messageSentAt: '2026-09-30T12:07:00.000Z',
    });
    expect(res1.status).toBe('acquired');
    expect(getEnrollment().ai_node_session?.last_inbound_at).toBe('2026-09-30T12:07:00.000Z');

    // Mensagem redelivered com timestamp MAIS ANTIGO (12:03:00) -> NÃO regride o relógio!
    await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-antiga-atrasada',
      messageSentAt: '2026-09-30T12:03:00.000Z',
    });
    // Continua mantendo 12:07:00 (o maior timestamp já registrado)
    expect(getEnrollment().ai_node_session?.last_inbound_at).toBe('2026-09-30T12:07:00.000Z');
  });

  it('Recuperação de outbound: se reply cache existe e send-ledger aceitou, não chama LLM nem reenvia WhatsApp', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 1,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEvents } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-outbound-recovery';

    // Grava resposta em cache
    await recordAiNodeReplyGenerated(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
      replyText: 'Mensagem já aceita pelo WhatsApp',
    });

    // Simula que o sendLedger já aceitou o outbound anteriormente
    const recoveryResult = await resolveAiNodeOutboundRecovery(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
      },
      async () => ({ status: 'accepted' }),
    );

    // Não deve chamar LLM, não deve enviar outbound, e completa automaticamente
    expect(recoveryResult.shouldCallLlm).toBe(false);
    expect(recoveryResult.shouldSendOutbound).toBe(false);
    expect(recoveryResult.cachedReply).toBe('Mensagem já aceita pelo WhatsApp');
    expect(recoveryResult.completed).toBe(true);

    // Verificou que o evento completed foi gravado
    expect(getEvents().filter((e) => e.event_type === 'ai_node.turn_completed')).toHaveLength(1);
  });
});

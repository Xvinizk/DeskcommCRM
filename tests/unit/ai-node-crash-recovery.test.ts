import { describe, expect, it } from 'vitest';
import {
  acquireAiNodeInboundTurn,
  completeAiNodeInboundTurn,
  recordAiNodeReplyGenerated,
  getAiNodeGeneratedReply,
  resolveAiNodeOutboundRecovery,
  renewAiNodeTurnLease,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import { createMockDb } from './ai-node-idempotency.test';

const defaultMediaSummary = {
  images_count: 0,
  audios_count: 0,
  documents_count: 0,
  last_media_ids: [],
};

describe('ai-node-crash-recovery: fencing token, stale workers e heartbeat', () => {
  it('CASO A: Worker A (gen 1) sofre crash/atraso -> Worker B assume (gen 2) -> Worker A tenta record reply e é rejeitado como stale_lease_owner', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
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

    const inboundMessageId = 'msg-fencing-test-a';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 1. Worker A adquire o claim (generation 1, lease de 60s)
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
    if (claimA.status === 'acquired') {
      expect(claimA.lease_generation).toBe(1);
      expect(claimA.worker_id).toBe('worker-A');
    }

    // 2. Operação do Worker A atrasa (>60s) e ele não renovou. Lease expira em 12:01:00.
    const tExpired = new Date('2026-09-30T12:01:05Z');

    // 3. Worker B chega e faz takeover (generation 2)
    const takeoverB = await acquireAiNodeInboundTurn(
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
    expect(takeoverB.status).toBe('resumed');
    if (takeoverB.status === 'resumed') {
      expect(takeoverB.lease_generation).toBe(2);
      expect(takeoverB.worker_id).toBe('worker-B');
    }

    // 4. Worker A finalmente acorda e tenta salvar a resposta com seu fencing token antigo (gen 1):
    const staleRecord = await recordAiNodeReplyGenerated(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        replyText: 'Resposta atrasada do Worker A antigo',
        workerId: 'worker-A',
        leaseGeneration: 1,
      },
      { clock: () => tExpired },
    );

    // DEVE SER REJEITADO com stale_lease_owner!
    expect(staleRecord.recorded).toBe(false);
    expect(staleRecord.error).toBe('stale_lease_owner');

    // Nenhuma resposta do Worker A foi gravada no ledger
    const replies = getEvents().filter((e) => e.event_type === 'ai_node.reply_generated');
    expect(replies).toHaveLength(0);
  });

  it('CASO B: Worker A antigo tenta completeAiNodeInboundTurn após takeover e é rejeitado como stale_lease_owner', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: defaultMediaSummary,
    };

    const { mockDb, getEvents, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const inboundMessageId = 'msg-fencing-test-b';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Worker A adquire gen 1
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

    // Worker B assume gen 2 após expiração
    const tExpired = new Date('2026-09-30T12:01:05Z');
    await acquireAiNodeInboundTurn(
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

    // Worker A tenta completar o turno
    const staleComplete = await completeAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
      },
      { clock: () => tExpired },
    );

    // Rejeitado!
    expect(staleComplete.status).toBe('stale_lease_owner');

    // Nenhum evento completed gravado
    expect(getEvents().filter((e) => e.event_type === 'ai_node.turn_completed')).toHaveLength(0);

    // active_turn ainda pertence ao Worker B (gen 2)
    expect(getEnrollment().ai_node_session?.active_turn?.worker_id).toBe('worker-B');
    expect(getEnrollment().ai_node_session?.active_turn?.lease_generation).toBe(2);
  });

  it('CASO C: Worker A faz heartbeat antes de expirar -> Worker B tenta takeover e recebe in_progress', async () => {
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

    const inboundMessageId = 'msg-heartbeat-test';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Worker A adquire claim (expiraria em 12:01:00)
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

    // Aos 40s (12:00:40), Worker A faz heartbeat renovando por mais 60s (novo prazo: 12:01:40)
    const tHeartbeat = new Date('2026-09-30T12:00:40Z');
    const renewResult = await renewAiNodeTurnLease(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
        renewDurationMs: 60_000,
      },
      { clock: () => tHeartbeat },
    );
    expect(renewResult.status).toBe('renewed');
    if (renewResult.status === 'renewed') {
      expect(renewResult.lease_until).toBe('2026-09-30T12:01:40.000Z');
    }

    // Aos 65s (12:01:05), Worker B tenta takeover achando que expirou:
    const tCheck = new Date('2026-09-30T12:01:05Z');
    const takeoverAttempt = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-B',
      },
      { clock: () => tCheck },
    );

    // Worker B é barrado porque a lease foi renovada pelo heartbeat de A!
    expect(takeoverAttempt.status).toBe('in_progress');
    if (takeoverAttempt.status === 'in_progress') {
      expect(takeoverAttempt.worker_id).toBe('worker-A');
      expect(takeoverAttempt.lease_generation).toBe(1);
      expect(takeoverAttempt.lease_until).toBe('2026-09-30T12:01:40.000Z');
    }
  });

  it('CASO D: Worker A morre sem heartbeat -> lease expira -> Worker B assume normalmente (resumed, gen 2)', async () => {
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

    const inboundMessageId = 'msg-dead-no-hb';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Worker A morre imediatamente após claim
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

    // Após 65s (sem heartbeat nenhum), Worker B assume
    const tExpired = new Date('2026-09-30T12:01:05Z');
    const takeoverResult = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-alive',
      },
      { clock: () => tExpired },
    );

    expect(takeoverResult.status).toBe('resumed');
    if (takeoverResult.status === 'resumed') {
      expect(takeoverResult.worker_id).toBe('worker-alive');
      expect(takeoverResult.lease_generation).toBe(2);
    }
  });

  it('CASO E: Worker A está numa operação longa (>60s) mas heartbeats continuam -> nenhum takeover ocorre', async () => {
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

    const inboundMessageId = 'msg-long-running-tool';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Claim inicial (expiraria em 12:01:00)
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

    // Heartbeat 1 aos 30s (renova até 12:01:30)
    await renewAiNodeTurnLease(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
        renewDurationMs: 60_000,
      },
      { clock: () => new Date('2026-09-30T12:00:30Z') },
    );

    // Tentativa concorrente aos 65s é barrada
    const check1 = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-intruder',
      },
      { clock: () => new Date('2026-09-30T12:01:05Z') },
    );
    expect(check1.status).toBe('in_progress');

    // Heartbeat 2 aos 60s (renova até 12:02:00)
    await renewAiNodeTurnLease(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
        renewDurationMs: 60_000,
      },
      { clock: () => new Date('2026-09-30T12:01:00Z') },
    );

    // Tentativa concorrente aos 90s é barrada
    const check2 = await acquireAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        expectedNodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-intruder',
      },
      { clock: () => new Date('2026-09-30T12:01:30Z') },
    );
    expect(check2.status).toBe('in_progress');

    // Worker A conclui aos 95s com sucesso usando fencing token original (gen 1)
    const completeA = await completeAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
      },
      { clock: () => new Date('2026-09-30T12:01:35Z') },
    );
    expect(completeA.status).toBe('completed');
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
  });

  it('CASO F: 20 workers tentam takeover de claim expirado -> exatamente 1 recebe nova generation (gen 2)', async () => {
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

    const inboundMessageId = 'msg-20-fencing';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // Worker inicial com gen 1
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

    // 20 workers simultâneos após a expiração
    const tExpired = new Date('2026-09-30T12:01:05Z');
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

    // Exatamente 1 ganhou resumed com generation 2
    const resumedList = results.filter((r) => r.status === 'resumed');
    expect(resumedList).toHaveLength(1);
    if (resumedList[0]?.status === 'resumed') {
      expect(resumedList[0].lease_generation).toBe(2);
    }

    // Os outros 19 receberam in_progress
    const inProgressList = results.filter((r) => r.status === 'in_progress');
    expect(inProgressList).toHaveLength(19);

    // Sessão gravou generation 2
    expect(getEnrollment().ai_node_session?.active_turn?.lease_generation).toBe(2);
  });

  it('CASO G: worker antigo termina depois do novo owner -> nenhuma mutação do antigo é aceita', async () => {
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

    const inboundMessageId = 'msg-stale-after-complete';
    const t0 = new Date('2026-09-30T12:00:00Z');

    // 1. Worker A adquire gen 1
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

    // 2. Worker B assume gen 2 após expiração
    const tExpired = new Date('2026-09-30T12:01:05Z');
    await acquireAiNodeInboundTurn(
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

    // 3. Worker B gera resposta e completa o turno com sucesso (gen 2)
    await recordAiNodeReplyGenerated(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        replyText: 'Resposta legítima do Worker B',
        workerId: 'worker-B',
        leaseGeneration: 2,
      },
      { clock: () => tExpired },
    );

    await completeAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        outboundMessageId: 'msg-outbound-b',
        workerId: 'worker-B',
        leaseGeneration: 2,
      },
      { clock: () => tExpired },
    );

    // 4. Worker A antigo acorda agora e tenta sobrescrever:
    const staleRecord = await recordAiNodeReplyGenerated(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        replyText: 'Tentativa de sobrescrever do Worker A',
        workerId: 'worker-A',
        leaseGeneration: 1,
      },
      { clock: () => new Date('2026-09-30T12:02:00Z') },
    );
    expect(staleRecord.recorded).toBe(false);
    expect(staleRecord.error).toBe('stale_lease_owner');

    const staleComplete = await completeAiNodeInboundTurn(
      mockDb,
      {
        organizationId: 'org-1',
        enrollmentId: 'enrollment-1',
        nodeId: 'node-ai-1',
        inboundMessageId,
        workerId: 'worker-A',
        leaseGeneration: 1,
      },
      { clock: () => new Date('2026-09-30T12:02:00Z') },
    );
    expect(staleComplete.status).toBe('stale_lease_owner');

    // A resposta recuperada do cache continua sendo a do Worker B!
    const reply = await getAiNodeGeneratedReply(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-1',
      inboundMessageId,
    });
    expect(reply?.reply_text).toBe('Resposta legítima do Worker B');
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

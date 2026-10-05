import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTurnAuthority: vi.fn(),
  acquireAiNodeInboundTurn: vi.fn(),
  executeAiNodeLifecycle: vi.fn(),
  rescheduleJob: vi.fn(),
}));

vi.mock('@/lib/agent-engine/agent/turn-authority', () => ({
  resolveTurnAuthority: mocks.resolveTurnAuthority,
}));

vi.mock('@/lib/followup/ai-node-idempotency', () => ({
  acquireAiNodeInboundTurn: mocks.acquireAiNodeInboundTurn,
}));

vi.mock('@/lib/followup/ai-node-lifecycle', () => ({
  executeAiNodeLifecycle: mocks.executeAiNodeLifecycle,
}));

vi.mock('@/lib/agent-engine/queue/queue', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    rescheduleJob: mocks.rescheduleJob,
  };
});

import { createInboundTurnHandler, JobSettledError, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

describe('InboundTurnHandler -> AI Node Concorrência (in_progress & rescheduleJob)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ids = {
    org: '11000000-0000-4000-8000-000000000001',
    contact: '11000000-0000-4000-8000-000000000002',
    conversation: '11000000-0000-4000-8000-000000000003',
    channel: '11000000-0000-4000-8000-000000000004',
    job: '11000000-0000-4000-8000-000000000005',
    inboundMsg: '11000000-0000-4000-8000-000000000006',
    activeMsg: '11000000-0000-4000-8000-000000000000',
    enrollment: '11000000-0000-4000-8000-000000000007',
    node: 'node-ai-1',
  };

  const job = {
    id: ids.job,
    organization_id: ids.org,
    contact_id: ids.contact,
    kind: 'inbound_turn',
    payload: {
      conversation_id: ids.conversation,
      contact_id: ids.contact,
      channel_session_id: ids.channel,
      inbound_message_id: ids.inboundMsg,
      crm_event_id: '11000000-0000-4000-8000-000000000008',
    },
  };

  it('quando acquireAiNodeInboundTurn retorna in_progress, reagenda com delay de 2s e lança JobSettledError sem abrir LLM', async () => {
    mocks.resolveTurnAuthority.mockResolvedValue({
      authority: 'ai_node',
      enrollment_id: ids.enrollment,
      node_id: ids.node,
    });

    mocks.acquireAiNodeInboundTurn.mockResolvedValue({
      status: 'in_progress',
      is_retry: false,
      enrollment_id: ids.enrollment,
      node_id: ids.node,
      inbound_message_id: ids.inboundMsg,
      active_inbound_message_id: ids.activeMsg,
      worker_id: 'worker-a',
      lease_until: new Date(Date.now() + 60000).toISOString(),
      lease_generation: 1,
    });

    const mockPool = {
      query: vi.fn(),
    };

    const turnDeps: InboundTurnDeps = {
      crmCfg: { supabase: {} as unknown } as unknown as InboundTurnDeps['crmCfg'],
      llmCfg: {} as unknown as InboundTurnDeps['llmCfg'],
      knobs: {} as unknown as InboundTurnDeps['knobs'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const handler = createInboundTurnHandler(turnDeps);

    await expect(
      handler(job as never, mockPool as never, { workerId: 'worker-b' }),
    ).rejects.toThrow(JobSettledError);

    // 1. Confirma que rescheduleJob foi chamado com os parâmetros exatos
    expect(mocks.rescheduleJob).toHaveBeenCalledTimes(1);
    expect(mocks.rescheduleJob).toHaveBeenCalledWith(
      mockPool,
      ids.job,
      'worker-b',
      expect.objectContaining({
        delayMs: 2000,
        reason: expect.stringContaining(`Node IA ocupado com turno ativo (${ids.activeMsg})`),
      }),
    );

    // 2. Confirma que executeAiNodeLifecycle NUNCA foi chamado
    expect(mocks.executeAiNodeLifecycle).not.toHaveBeenCalled();
  });
});

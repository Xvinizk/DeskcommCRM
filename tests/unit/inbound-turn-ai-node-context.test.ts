import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTurnAuthority: vi.fn(),
  acquireAiNodeInboundTurn: vi.fn(),
  executeAiNodeLifecycle: vi.fn(),
  loadInboundBodyForJob: vi.fn(),
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

vi.mock('@/lib/agent-engine/agent/inbound-turn', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
  };
});

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import { getLeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';

describe('InboundTurnHandler -> AI Node getLeadContextFn injection', () => {
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

  it('propaga getLeadContextFn canônico para executeAiNodeLifecycle quando deps padrão é usado', async () => {
    mocks.resolveTurnAuthority.mockResolvedValue({
      authority: 'ai_node',
      enrollment_id: ids.enrollment,
      node_id: ids.node,
    });

    mocks.acquireAiNodeInboundTurn.mockResolvedValue({
      status: 'acquired',
      worker_id: 'worker-1',
      lease_generation: 1,
      session: { node_id: ids.node, turn_count: 1 },
    });

    mocks.executeAiNodeLifecycle.mockResolvedValue({
      status: 'completed',
    });

    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ body: 'BURST PARTE 3 — código GAMA', type: 'chat' }],
      }),
    };

    const turnDeps: InboundTurnDeps = {
      crmCfg: { supabase: {} as unknown } as unknown as InboundTurnDeps['crmCfg'],
      llmCfg: {} as unknown as InboundTurnDeps['llmCfg'],
      knobs: {} as unknown as InboundTurnDeps['knobs'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const handler = createInboundTurnHandler(turnDeps);
    await handler(job as never, mockPool as never, { workerId: 'worker-1' });

    expect(mocks.executeAiNodeLifecycle).toHaveBeenCalledTimes(1);
    const lifecycleDeps = mocks.executeAiNodeLifecycle.mock.calls[0]![2];
    expect(lifecycleDeps).toBeDefined();
    expect(typeof lifecycleDeps.getLeadContextFn).toBe('function');
    expect(lifecycleDeps.getLeadContextFn).toBe(getLeadContext);
  });

  it('permite que turnDeps injete um getLeadContextFn mock customizado', async () => {
    mocks.resolveTurnAuthority.mockResolvedValue({
      authority: 'ai_node',
      enrollment_id: ids.enrollment,
      node_id: ids.node,
    });

    mocks.acquireAiNodeInboundTurn.mockResolvedValue({
      status: 'acquired',
      worker_id: 'worker-1',
      lease_generation: 1,
      session: { node_id: ids.node, turn_count: 1 },
    });

    mocks.executeAiNodeLifecycle.mockResolvedValue({
      status: 'completed',
    });

    const mockPool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ body: 'BURST PARTE 3 — código GAMA', type: 'chat' }],
      }),
    };

    const customContextFn = vi.fn();
    const turnDeps: InboundTurnDeps = {
      crmCfg: { supabase: {} as unknown } as unknown as InboundTurnDeps['crmCfg'],
      llmCfg: {} as unknown as InboundTurnDeps['llmCfg'],
      knobs: {} as unknown as InboundTurnDeps['knobs'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getLeadContextFn: customContextFn as unknown as typeof getLeadContext,
    };

    const handler = createInboundTurnHandler(turnDeps);
    await handler(job as never, mockPool as never, { workerId: 'worker-1' });

    expect(mocks.executeAiNodeLifecycle).toHaveBeenCalledTimes(1);
    const lifecycleDeps = mocks.executeAiNodeLifecycle.mock.calls[0]![2];
    expect(lifecycleDeps.getLeadContextFn).toBe(customContextFn);
  });
});

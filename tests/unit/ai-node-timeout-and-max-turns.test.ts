import { describe, it, expect, vi } from 'vitest';
import {
  executeAiNodeLifecycle,
  executeAiNodeTimeout,
  type ExecuteAiNodeLifecycleInput,
  type ExecuteAiNodeLifecycleDeps,
} from '@/lib/followup/ai-node-lifecycle';
import {
  acquireAiNodeInboundTurn,
  type DbPoolLike,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import {
  AI_NODE_COMPLETED_BRANCH_ID,
  AI_NODE_TIMEOUT_BRANCH_ID,
  AI_NODE_MAX_TURNS_BRANCH_ID,
  AI_NODE_HANDOFF_BRANCH_ID,
  AI_NODE_ERROR_BRANCH_ID,
  type AiNodeConfig,
  type FlowGraph,
} from '@/lib/followup/graph-schema';
import { processNode, type EnrollmentRow } from '@/lib/followup/node-handlers';

interface MockEnrollmentData {
  id: string;
  organization_id: string;
  current_node_id: string;
  contact_id: string;
  conversation_id: string | null;
  pointer_id?: string;
  version_id: string;
  status: string;
  steps_taken: number;
  outcome: string | null;
  completed_at: string | null;
  ai_node_session: AiNodeSession;
  graph: FlowGraph;
  next_eval_at?: string | null;
  claimed_until?: string | null;
  attempts?: number;
}

function createTimeoutAndMaxTurnsHarness(initial: {
  enrollmentId: string;
  organizationId: string;
  nodeId: string;
  contactId: string;
  conversationId: string;
  graph: FlowGraph;
  session?: Partial<AiNodeSession>;
  nextEvalAt?: string | null;
}) {
  const fullSession: AiNodeSession = {
    node_id: initial.nodeId,
    mode: 'custom_prompt',
    turn_count: 0,
    started_at: new Date('2026-10-01T10:00:00Z').toISOString(),
    media_summary: {
      images_count: 0,
      audios_count: 0,
      documents_count: 0,
      last_media_ids: [],
    },
    active_turn: null, // Inicialmente sem active_turn (nó aguardando lead)
    extracted_data: {},
    status: 'running',
    ...initial.session,
  };

  const enrollment: MockEnrollmentData = {
    id: initial.enrollmentId,
    organization_id: initial.organizationId,
    current_node_id: initial.nodeId,
    contact_id: initial.contactId,
    conversation_id: initial.conversationId,
    version_id: 'v1',
    status: 'active',
    steps_taken: 0,
    outcome: null,
    completed_at: null,
    ai_node_session: fullSession,
    graph: initial.graph,
    next_eval_at: initial.nextEvalAt ?? null,
  };

  const events: Array<Record<string, unknown>> = [];
  const jobQueue: Array<Record<string, unknown>> = [];
  const advanceCalls: Array<{ enrollmentId: string; nextNodeId: string }> = [];

  const mockDb: DbPoolLike = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      if (normalizedSql.startsWith('BEGIN') || normalizedSql.startsWith('COMMIT') || normalizedSql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      // SELECT organizations / ai_budgets
      if (
        normalizedSql.includes('FROM ORGANIZATIONS') ||
        normalizedSql.includes('FROM organizations') ||
        normalizedSql.includes('FROM ai_budgets')
      ) {
        return {
          rows: [
            {
              id: enrollment.organization_id,
              settings: { llm: { provider: 'anthropic', model: 'claude-3-5-sonnet' } },
              modo: 'off',
              teto: 0,
            } as T,
          ],
        };
      }

      // SELECT FOR UPDATE enrollment
      if (normalizedSql.includes('FROM followup_enrollments') && normalizedSql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              id: enrollment.id,
              current_node_id: enrollment.current_node_id,
              status: enrollment.status,
              ai_node_session: enrollment.ai_node_session,
              contact_id: enrollment.contact_id,
              conversation_id: enrollment.conversation_id,
              next_eval_at: enrollment.next_eval_at,
              version_id: enrollment.version_id,
              graph: enrollment.graph,
            } as T,
          ],
        };
      }

      // SELECT enrollment (não for update)
      if (
        normalizedSql.includes('SELECT e.current_node_id') ||
        normalizedSql.includes('SELECT current_node_id') ||
        normalizedSql.includes('SELECT ai_node_session')
      ) {
        return {
          rows: [
            {
              current_node_id: enrollment.current_node_id,
              contact_id: enrollment.contact_id,
              conversation_id: enrollment.conversation_id,
              ai_node_session: enrollment.ai_node_session,
              graph: enrollment.graph,
              status: enrollment.status,
              next_eval_at: enrollment.next_eval_at,
            } as T,
          ],
        };
      }

      // SELECT followup_enrollment_events
      if (normalizedSql.includes('FROM followup_enrollment_events')) {
        if (normalizedSql.includes('WHERE enrollment_id = $1 AND idempotency_key = $2')) {
          const [, key] = params;
          const match = events.find((e) => e.idempotency_key === key);
          return { rows: match ? ([match] as T[]) : [] };
        }
        return { rows: events as T[] };
      }

      // INSERT INTO followup_enrollment_events
      if (normalizedSql.includes('INSERT INTO followup_enrollment_events')) {
        const [, , nodeId, eventType, payload, idemKey, createdAt] = params;
        const exists = events.some((e) => e.idempotency_key === idemKey);
        if (!exists) {
          const newEvt = {
            id: `event-${events.length + 1}`,
            node_id: nodeId,
            event_type: eventType,
            payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
            idempotency_key: idemKey,
            created_at: createdAt,
          };
          events.push(newEvt);
          return { rows: [{ id: newEvt.id } as T] };
        }
        return { rows: [] };
      }

      // UPDATE followup_enrollments
      if (normalizedSql.includes('UPDATE followup_enrollments')) {
        if (normalizedSql.includes('SET current_node_id = $1')) {
          const [nextNodeId, sessionJson, nextEvalAt] = params;
          enrollment.current_node_id = nextNodeId as string;
          enrollment.steps_taken += 1;
          enrollment.ai_node_session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : sessionJson;
          enrollment.next_eval_at = nextEvalAt as string;
          enrollment.status = 'active';
        } else if (normalizedSql.includes('ai_node_session = $1')) {
          const [sessionJson] = params;
          enrollment.ai_node_session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : sessionJson;
          if (normalizedSql.includes('next_eval_at = $2')) {
            enrollment.next_eval_at = params[1] as string;
          }
        } else if (normalizedSql.includes('next_eval_at = $1')) {
          enrollment.next_eval_at = params[0] as string;
        } else if (normalizedSql.includes("SET status = 'paused_handoff'")) {
          enrollment.status = 'paused_handoff';
          enrollment.next_eval_at = null;
        }
        return { rows: [] };
      }

      // INSERT INTO job_queue
      if (normalizedSql.includes('INSERT INTO job_queue')) {
        // Query: INSERT INTO job_queue (organization_id, contact_id, kind, payload, source_event_id, run_after, status) VALUES ($1, $2, 'followup_turn', $3, $4, $5, 'pending')
        const [orgId, contactId, payload, sourceEventId, runAfter] = params;
        jobQueue.push({
          organization_id: orgId,
          contact_id: contactId,
          kind: 'followup_turn',
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          source_event_id: sourceEventId,
          run_after: runAfter,
        });
        return { rows: [{ id: 'job-1' } as T] };
      }

      return { rows: [] };
    },
  };

  const advanceEnrollmentFn = vi.fn().mockImplementation(async (enrId: string, _orgId: string, nextId: string) => {
    advanceCalls.push({ enrollmentId: enrId, nextNodeId: nextId });
  });

  const runLifecycle = async (
    input: ExecuteAiNodeLifecycleInput,
    deps: ExecuteAiNodeLifecycleDeps & {
      generateStructuredOutputFn?: () => Promise<{
        reply?: string;
        node_status: 'continue' | 'completed' | 'handoff';
        outcome?: string | null;
        extracted_data?: Record<string, unknown>;
      }>;
    } = {},
  ) => {
    // Se ainda não houver active_turn, arma a titularidade com a mensagem e worker fornecidos
    if (!enrollment.ai_node_session.active_turn) {
      enrollment.ai_node_session.active_turn = {
        inbound_message_id: input.inboundMessageId,
        worker_id: input.workerId,
        lease_generation: input.leaseGeneration,
        claimed_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + 60_000).toISOString(),
        attempts: 1,
      };
    }

    let runModelCallFn = deps.runModelCallFn;
    if (!runModelCallFn) {
      if (deps.generateStructuredOutputFn) {
        const genFn = deps.generateStructuredOutputFn;
        runModelCallFn = vi.fn().mockImplementation(async () => {
          const struct = await genFn();
          return {
            result: {
              text: JSON.stringify(struct),
            },
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        });
      } else {
        runModelCallFn = vi.fn().mockResolvedValue({
          result: {
            text: JSON.stringify({
              reply: 'Resposta padrão do assistente.',
              node_status: 'continue',
            }),
          },
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          usage: { inputTokens: 50, outputTokens: 20 },
        });
      }
    }

    const enrichedInput: ExecuteAiNodeLifecycleInput = {
      ...input,
      contactId: input.contactId ?? enrollment.contact_id,
      conversationId: input.conversationId ?? enrollment.conversation_id,
      session: input.session ?? enrollment.ai_node_session,
      graph: input.graph ?? enrollment.graph,
      nodeConfig:
        input.nodeConfig ??
        (enrollment.graph?.nodes.find((n) => n.id === input.nodeId)?.config as AiNodeConfig),
    };

    return executeAiNodeLifecycle(mockDb, enrichedInput, {
      advanceEnrollmentFn,
      ...deps,
      runModelCallFn,
    });
  };

  return {
    mockDb,
    getEnrollment: () => enrollment,
    getEvents: () => events,
    getJobQueue: () => jobQueue,
    getAdvanceCalls: () => advanceCalls,
    advanceEnrollmentFn,
    runLifecycle,
  };
}

const baseGraphWith5Branches: FlowGraph = {
  nodes: [
    {
      id: 'node-ai-1',
      type: 'ai_node',
      label: 'Agente IA',
      position: { x: 100, y: 100 },
      config: {
        mode: 'custom_prompt',
        custom_prompt: 'Você é um assistente.',
        timeout: { duration_value: 24, unit: 'hours' },
        max_turns: 10,
      },
    },
    {
      id: 'node-completed-target',
      type: 'message_text',
      label: 'Concluído',
      position: { x: 300, y: 100 },
      config: { body: 'Atendimento concluído!' },
    },
    {
      id: 'node-timeout-target',
      type: 'message_text',
      label: 'Timeout',
      position: { x: 300, y: 200 },
      config: { body: 'Cliente não respondeu, tempo esgotado.' },
    },
    {
      id: 'node-maxturns-target',
      type: 'message_text',
      label: 'Max Turns',
      position: { x: 300, y: 300 },
      config: { body: 'Limite de mensagens atingido.' },
    },
    {
      id: 'node-handoff-target',
      type: 'message_text',
      label: 'Handoff',
      position: { x: 300, y: 400 },
      config: { body: 'Transferindo para humano.' },
    },
    {
      id: 'node-error-target',
      type: 'message_text',
      label: 'Erro',
      position: { x: 300, y: 500 },
      config: { body: 'Erro na IA.' },
    },
  ],
  edges: [
    {
      id: 'e-completed',
      source: 'node-ai-1',
      target: 'node-completed-target',
      priority: 0,
      condition: { type: 'branch', branch_id: AI_NODE_COMPLETED_BRANCH_ID },
    },
    {
      id: 'e-timeout',
      source: 'node-ai-1',
      target: 'node-timeout-target',
      priority: 1,
      condition: { type: 'branch', branch_id: AI_NODE_TIMEOUT_BRANCH_ID },
    },
    {
      id: 'e-maxturns',
      source: 'node-ai-1',
      target: 'node-maxturns-target',
      priority: 2,
      condition: { type: 'branch', branch_id: AI_NODE_MAX_TURNS_BRANCH_ID },
    },
    {
      id: 'e-handoff',
      source: 'node-ai-1',
      target: 'node-handoff-target',
      priority: 3,
      condition: { type: 'branch', branch_id: AI_NODE_HANDOFF_BRANCH_ID },
    },
    {
      id: 'e-error',
      source: 'node-ai-1',
      target: 'node-error-target',
      priority: 4,
      condition: { type: 'branch', branch_id: AI_NODE_ERROR_BRANCH_ID },
    },
  ],
};

describe('FASE 6: TIMEOUT OPERACIONAL + MAX_TURNS OPERACIONAL DO NODE IA', () => {
  // =========================================================================
  // SEÇÃO 1: TESTES OBRIGATÓRIOS — TIMEOUT (A a J)
  // =========================================================================

  it('A. Entrada no ai_node arma deadline (next_eval_at = now + timeout, status wait, wake ativo)', () => {
    const originalEnv = process.env.FOLLOWUP_AI_NODE_ENABLED;
    process.env.FOLLOWUP_AI_NODE_ENABLED = 'true';

    try {
      const now = new Date('2026-10-01T10:00:00Z');
      const clock = () => now;

      const aiNode = baseGraphWith5Branches.nodes[0]!;
      const enrollment: EnrollmentRow = {
        id: 'enr-1',
        organization_id: 'org-1',
        pointer_id: 'ptr-1',
        version_id: 'v1',
        contact_id: 'contact-1',
        conversation_id: 'conv-1',
        current_node_id: 'node-ai-1',
        status: 'active',
        next_eval_at: null,
        claimed_until: null,
        attempts: 0,
        max_attempts: 3,
        last_error: null,
        steps_taken: 0,
        outcome: null,
        cancel_reason: null,
        started_at: now.toISOString(),
        completed_at: null,
        updated_at: now.toISOString(),
      };

      // 1ª Entrada: waitElapsed = false
      const result = processNode({
        node: aiNode,
        edges: baseGraphWith5Branches.edges,
        enrollment,
        lead: { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null },
        clock,
        waitElapsed: false,
      });

      expect(result.kind).toBe('wait');
      if (result.kind === 'wait') {
        expect(result.wake_status).toBe('active');
        // Timeout configurado: 24 horas = 86_400_000 ms
        const expectedDeadline = new Date(now.getTime() + 86_400_000);
        expect(result.next_eval_at.toISOString()).toBe(expectedDeadline.toISOString());
      }
    } finally {
      process.env.FOLLOWUP_AI_NODE_ENABLED = originalEnv;
    }
  });

  it('B. continue rearma timeout após a resposta da IA', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const clock = () => now;

    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-b',
      organizationId: 'org-b',
      nodeId: 'node-ai-1',
      contactId: 'contact-b',
      conversationId: 'conv-b',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 1,
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-b',
      enrollmentId: 'enr-b',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-1',
      contactId: 'contact-b',
      conversationId: 'conv-b',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
    };

    const result = await harness.runLifecycle(input, {
      clock,
      generateStructuredOutputFn: async () => ({
        reply: 'Olá! Como posso ajudar você hoje?',
        node_status: 'continue',
      }),
      isLeadInHandoffFn: async () => false,
      sendWithLedgerFn: async () => ({ kind: 'sent', idempotencyKey: 'idem-crm-out-1', crmMessageId: 'crm-out-1' }),
    });

    expect(result.status).toBe('continue');
    expect(result.outboundStatus).toBe('outbound_fresh');

    const updatedEnr = harness.getEnrollment();
    // Prazo renovado para 24h a partir do momento em que a IA respondeu
    const expectedDeadline = new Date(now.getTime() + 86_400_000).toISOString();
    expect(updatedEnr.next_eval_at).toBe(expectedDeadline);
    expect(updatedEnr.ai_node_session.timeout_at).toBe(expectedDeadline);
    expect(updatedEnr.ai_node_session.status).toBe('running');

    // Evento ai_node.timeout_rearmed emitido
    const rearmedEvent = harness.getEvents().find((e) => e.event_type === 'ai_node.timeout_rearmed');
    expect(rearmedEvent).toBeDefined();
    expect((rearmedEvent?.payload as Record<string, unknown>).next_eval_at).toBe(expectedDeadline);
    expect((rearmedEvent?.payload as Record<string, unknown>).timeout_ms).toBe(86_400_000);
  });

  it('C. job de timeout antigo após rearm -> stale/no-op (ai_node.timeout_stale_ignored)', async () => {
    // Cliente respondeu às 11:00, estendendo o timeout para 12:00
    const extendedDeadline = new Date('2026-10-01T12:00:00Z').toISOString();

    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-c',
      organizationId: 'org-c',
      nodeId: 'node-ai-1',
      contactId: 'contact-c',
      conversationId: 'conv-c',
      graph: baseGraphWith5Branches,
      nextEvalAt: extendedDeadline,
      session: {
        status: 'running',
        timeout_at: extendedDeadline,
      },
    });

    // O job antigo acorda às 10:30 (antes da nova deadline de 12:00)
    const wakeupTime = new Date('2026-10-01T10:30:00Z');
    const clock = () => wakeupTime;

    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-c',
        enrollmentId: 'enr-c',
        nodeId: 'node-ai-1',
        contactId: 'contact-c',
        graph: baseGraphWith5Branches,
      },
      { clock, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    expect(timeoutRes.status).toBe('stale_ignored');
    expect(timeoutRes.reason).toBe('deadline_extended_by_recent_inbound');

    // Enrollment permanece inalterado e não avança
    expect(harness.getEnrollment().current_node_id).toBe('node-ai-1');
    expect(harness.getAdvanceCalls().length).toBe(0);

    // Evento ai_node.timeout_stale_ignored emitido
    const staleEvent = harness.getEvents().find((e) => e.event_type === 'ai_node.timeout_stale_ignored');
    expect(staleEvent).toBeDefined();
    expect((staleEvent?.payload as Record<string, unknown>).reason).toBe('deadline_in_future');
  });

  it('D. inbound ganha corrida x timeout -> inbound processado, deadline renovada, timeout não avança', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-d',
      organizationId: 'org-d',
      nodeId: 'node-ai-1',
      contactId: 'contact-d',
      conversationId: 'conv-d',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:30:00Z').toISOString(),
      session: {
        status: 'running',
        turn_count: 1,
        active_turn: null, // Livre para acquire
        timeout_at: new Date('2026-10-01T10:30:00Z').toISOString(),
      },
    });

    // 1. Inbound adquire o claim com lock atômico às 10:29
    const inboundTime = new Date('2026-10-01T10:29:00Z');
    const acquireRes = await acquireAiNodeInboundTurn(harness.mockDb, {
      organizationId: 'org-d',
      enrollmentId: 'enr-d',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-race-d',
      messageSentAt: inboundTime,
      workerId: 'worker-inbound',
    });

    expect(acquireRes.status).toBe('acquired');

    // Inbound processa e rearma o timeout para 24h depois (10:29 + 24h = amanhã)
    const lifecycleRes = await harness.runLifecycle(
      {
        organizationId: 'org-d',
        enrollmentId: 'enr-d',
        nodeId: 'node-ai-1',
        inboundMessageId: 'msg-race-d',
        workerId: 'worker-inbound',
        leaseGeneration: acquireRes.status === 'acquired' ? acquireRes.lease_generation : 1,
        graph: baseGraphWith5Branches,
        contactId: 'contact-d',
      },
      {
        clock: () => inboundTime,
        generateStructuredOutputFn: async () => ({
          reply: 'Resposta rápida!',
          node_status: 'continue',
        }),
        isLeadInHandoffFn: async () => false,
        sendWithLedgerFn: async () => ({ kind: 'sent', idempotencyKey: 'idem-crm-d-1', crmMessageId: 'crm-d-1' }),
      },
    );

    expect(lifecycleRes.status).toBe('continue');

    // 2. Timeout que estava agendado para 10:30 acorda às 10:30
    const timeoutWakeTime = new Date('2026-10-01T10:30:00Z');
    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-d',
        enrollmentId: 'enr-d',
        nodeId: 'node-ai-1',
        contactId: 'contact-d',
        graph: baseGraphWith5Branches,
      },
      { clock: () => timeoutWakeTime, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    // Timeout detecta que o prazo foi renovado -> stale/no-op!
    expect(timeoutRes.status).toBe('stale_ignored');
    expect(harness.getEnrollment().current_node_id).toBe('node-ai-1');
  });

  it('E. timeout ganha corrida x inbound -> timeout avança, inbound vê node_changed', async () => {
    const expiredTime = new Date('2026-10-01T11:00:00Z');
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-e',
      organizationId: 'org-e',
      nodeId: 'node-ai-1',
      contactId: 'contact-e',
      conversationId: 'conv-e',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:59:00Z').toISOString(), // Já expirou
      session: {
        status: 'running',
        turn_count: 2,
        active_turn: null,
        timeout_at: new Date('2026-10-01T10:59:00Z').toISOString(),
      },
    });

    // 1. Timeout ganha o lock primeiro e transiciona para 'node-timeout-target'
    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-e',
        enrollmentId: 'enr-e',
        nodeId: 'node-ai-1',
        contactId: 'contact-e',
        graph: baseGraphWith5Branches,
      },
      { clock: () => expiredTime, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    expect(timeoutRes.status).toBe('timeout');
    expect(timeoutRes.nextNodeId).toBe('node-timeout-target');
    expect(harness.getEnrollment().current_node_id).toBe('node-timeout-target');
    expect(harness.getEnrollment().ai_node_session.status).toBe('timeout');

    // 2. Inbound atrasado tenta processar no nó antigo 'node-ai-1'
    const acquireRes = await acquireAiNodeInboundTurn(harness.mockDb, {
      organizationId: 'org-e',
      enrollmentId: 'enr-e',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-late-e',
      workerId: 'worker-late',
    });

    // Inbound detecta que o nó mudou atomicamente e NÃO executa a IA antiga!
    expect(acquireRes.status).toBe('node_changed');
  });

  it('F. LLM > timeout com lease ativa -> timeout não mata turno em andamento', async () => {
    const now = new Date('2026-10-01T10:00:30Z');
    // Lease da LLM vai até 10:01:00
    const leaseUntil = new Date('2026-10-01T10:01:00Z').toISOString();

    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-f',
      organizationId: 'org-f',
      nodeId: 'node-ai-1',
      contactId: 'contact-f',
      conversationId: 'conv-f',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:00:20Z').toISOString(), // Prazo formal expirou
      session: {
        status: 'running',
        active_turn: {
          inbound_message_id: 'msg-slow-llm',
          worker_id: 'worker-llm',
          claimed_at: new Date('2026-10-01T10:00:00Z').toISOString(),
          lease_until: leaseUntil,
          attempts: 1,
          lease_generation: 1,
        },
      },
    });

    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-f',
        enrollmentId: 'enr-f',
        nodeId: 'node-ai-1',
        contactId: 'contact-f',
        graph: baseGraphWith5Branches,
      },
      { clock: () => now, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    // Timeout não mata o turno: adia avaliação com segurança
    expect(timeoutRes.status).toBe('deferred_active_turn');
    expect(timeoutRes.reason).toBe('turn_in_flight');
    expect(harness.getEnrollment().current_node_id).toBe('node-ai-1');
    expect(harness.getAdvanceCalls().length).toBe(0);
  });

  it('G. humano assumiu -> timeout não avança fluxo (HUMANO > IA)', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-g',
      organizationId: 'org-g',
      nodeId: 'node-ai-1',
      contactId: 'contact-g',
      conversationId: 'conv-g',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T11:00:00Z').toISOString(),
      session: {
        status: 'running',
        active_turn: null,
        timeout_at: new Date('2026-10-01T11:00:00Z').toISOString(),
      },
    });

    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-g',
        enrollmentId: 'enr-g',
        nodeId: 'node-ai-1',
        contactId: 'contact-g',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => now,
        isLeadInHandoffFn: async () => true, // Humano ativo!
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    expect(timeoutRes.status).toBe('aborted_human_takeover');
    expect(timeoutRes.reason).toBe('human_takeover_active');
    // Enrollment pausado em paused_handoff, não avançou para timeout
    expect(harness.getEnrollment().status).toBe('paused_handoff');
    expect(harness.getAdvanceCalls().length).toBe(0);
  });

  it('H. timeout legítimo -> zero LLM, branch timeout', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-h',
      organizationId: 'org-h',
      nodeId: 'node-ai-1',
      contactId: 'contact-h',
      conversationId: 'conv-h',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T11:00:00Z').toISOString(),
      session: {
        status: 'running',
        active_turn: null,
        timeout_at: new Date('2026-10-01T11:00:00Z').toISOString(),
      },
    });

    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-h',
        enrollmentId: 'enr-h',
        nodeId: 'node-ai-1',
        contactId: 'contact-h',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => now,
        isLeadInHandoffFn: async () => false,
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    expect(timeoutRes.status).toBe('timeout');
    expect(timeoutRes.nextNodeId).toBe('node-timeout-target');
    expect(timeoutRes.transitionStatus).toBe('transition_fresh');

    // Sessão atualizada para status = timeout e completion_reason = timeout
    expect(harness.getEnrollment().ai_node_session.status).toBe('timeout');
    expect(harness.getEnrollment().ai_node_session.completion_reason).toBe('timeout');
    expect(harness.getEnrollment().current_node_id).toBe('node-timeout-target');

    // Eventos emitidos
    const events = harness.getEvents().map((e) => e.event_type);
    expect(events).toContain('ai_node.timeout');
    expect(events).toContain('ai_node.exited');

    // advanceEnrollmentFn chamado com target da branch timeout
    expect(harness.getAdvanceCalls()).toEqual([
      { enrollmentId: 'enr-h', nextNodeId: 'node-timeout-target' },
    ]);
  });

  it('I. timeout sem branch -> fallback para error branch ou fail-closed seguro', async () => {
    const now = new Date('2026-10-01T12:00:00Z');

    // Grafo SEM a branch timeout, mas COM a branch error
    const graphWithOnlyError: FlowGraph = {
      nodes: baseGraphWith5Branches.nodes,
      edges: [
        {
          id: 'e-error',
          source: 'node-ai-1',
          target: 'node-error-target',
          priority: 0,
          condition: { type: 'branch', branch_id: AI_NODE_ERROR_BRANCH_ID },
        },
      ],
    };

    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-i1',
      organizationId: 'org-i',
      nodeId: 'node-ai-1',
      contactId: 'contact-i',
      conversationId: 'conv-i',
      graph: graphWithOnlyError,
      nextEvalAt: new Date('2026-10-01T11:00:00Z').toISOString(),
      session: { status: 'running', active_turn: null },
    });

    const resErrorFallback = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-i',
        enrollmentId: 'enr-i1',
        nodeId: 'node-ai-1',
        contactId: 'contact-i',
        graph: graphWithOnlyError,
      },
      { clock: () => now, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    expect(resErrorFallback.status).toBe('timeout');
    expect(resErrorFallback.nextNodeId).toBe('node-error-target');
    expect(resErrorFallback.reason).toBe('missing_timeout_branch_fallback_error');

    // Grafo SEM NENHUMA branch (nem timeout, nem error) -> fail-closed
    const graphWithNoBranches: FlowGraph = {
      nodes: baseGraphWith5Branches.nodes,
      edges: [],
    };

    const harness2 = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-i2',
      organizationId: 'org-i',
      nodeId: 'node-ai-1',
      contactId: 'contact-i',
      conversationId: 'conv-i',
      graph: graphWithNoBranches,
      nextEvalAt: new Date('2026-10-01T11:00:00Z').toISOString(),
      session: { status: 'running', active_turn: null },
    });

    const resFailClosed = await executeAiNodeTimeout(
      harness2.mockDb,
      {
        organizationId: 'org-i',
        enrollmentId: 'enr-i2',
        nodeId: 'node-ai-1',
        contactId: 'contact-i',
        graph: graphWithNoBranches,
      },
      { clock: () => now, advanceEnrollmentFn: harness2.advanceEnrollmentFn },
    );

    expect(resFailClosed.status).toBe('error');
    expect(resFailClosed.reason).toBe('missing_timeout_branch_fail_closed');
    expect(harness2.getEnrollment().ai_node_session.status).toBe('error');
  });

  it('J. crash pós-timeout transition -> target executa exatamente 1x', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-j',
      organizationId: 'org-j',
      nodeId: 'node-ai-1',
      contactId: 'contact-j',
      conversationId: 'conv-j',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T11:00:00Z').toISOString(),
      session: { status: 'running', active_turn: null },
    });

    // 1. Timeout executa com sucesso primeira vez
    const firstRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-j',
        enrollmentId: 'enr-j',
        nodeId: 'node-ai-1',
        contactId: 'contact-j',
        graph: baseGraphWith5Branches,
      },
      { clock: () => now, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    expect(firstRes.transitionStatus).toBe('transition_fresh');
    expect(harness.getAdvanceCalls().length).toBe(1);

    // 2. Worker cai e retry acorda novamente para o mesmo timeout
    // Como a transição já alterou o current_node_id para 'node-timeout-target',
    // nova chamada para 'node-ai-1' detecta que o nó já mudou (node_changed)
    const retryRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-j',
        enrollmentId: 'enr-j',
        nodeId: 'node-ai-1',
        contactId: 'contact-j',
        graph: baseGraphWith5Branches,
      },
      { clock: () => now, advanceEnrollmentFn: harness.advanceEnrollmentFn },
    );

    expect(retryRes.status).toBe('node_changed');
    // Não duplica a transição nem a chamada de advance
    expect(harness.getAdvanceCalls().length).toBe(1);
  });

  // =========================================================================
  // SEÇÃO 2: TESTES OBRIGATÓRIOS — MAX_TURNS (K a R)
  // =========================================================================

  it('K. max_turns = 10, turn_count 9 -> continue normal', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-k',
      organizationId: 'org-k',
      nodeId: 'node-ai-1',
      contactId: 'contact-k',
      conversationId: 'conv-k',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 9, // Turno 9 de 10
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-k',
      enrollmentId: 'enr-k',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-9',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-k',
    };

    const result = await harness.runLifecycle(input, {
      generateStructuredOutputFn: async () => ({
        reply: 'Mensagem no turno 9: continue normal.',
        node_status: 'continue',
      }),
      isLeadInHandoffFn: async () => false,
      sendWithLedgerFn: async () => ({ kind: 'sent', idempotencyKey: 'idem-crm-k-1', crmMessageId: 'crm-k-1' }),
    });

    expect(result.status).toBe('continue');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(harness.getEnrollment().current_node_id).toBe('node-ai-1');
    expect(harness.getEnrollment().ai_node_session.status).toBe('running');
  });

  it('L. turno 10 retorna completed -> completed vence com precedência', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-l',
      organizationId: 'org-l',
      nodeId: 'node-ai-1',
      contactId: 'contact-l',
      conversationId: 'conv-l',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10, // Turno 10
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-l',
      enrollmentId: 'enr-l',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-10-completed',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-l',
    };

    const result = await harness.runLifecycle(input, {
      generateStructuredOutputFn: async () => ({
        reply: 'Perfeito! Seus dados foram validados.',
        node_status: 'completed',
        outcome: 'qualified',
      }),
      isLeadInHandoffFn: async () => false,
      sendWithLedgerFn: async () => ({ kind: 'sent', idempotencyKey: 'idem-crm-l-1', crmMessageId: 'crm-l-1' }),
    });

    expect(result.status).toBe('completed');
    expect(result.nextNodeId).toBe('node-completed-target');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(harness.getEnrollment().current_node_id).toBe('node-completed-target');
    expect(harness.getEnrollment().ai_node_session.status).toBe('completed');
  });

  it('M. turno 10 retorna handoff -> handoff vence com precedência', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-m',
      organizationId: 'org-m',
      nodeId: 'node-ai-1',
      contactId: 'contact-m',
      conversationId: 'conv-m',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10,
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-m',
      enrollmentId: 'enr-m',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-10-handoff',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-m',
    };

    const performHandoffSpy = vi.fn().mockResolvedValue({ success: true });

    const result = await harness.runLifecycle(input, {
      generateStructuredOutputFn: async () => ({
        reply: 'Vou transferir seu caso para um especialista.',
        node_status: 'handoff',
        outcome: 'needs_human',
      }),
      isLeadInHandoffFn: async () => false,
      performHumanHandoffFn: performHandoffSpy as unknown as ExecuteAiNodeLifecycleDeps['performHumanHandoffFn'],
      sendWithLedgerFn: async () => ({ kind: 'sent', idempotencyKey: 'idem-crm-m-1', crmMessageId: 'crm-m-1' }),
    });

    expect(result.status).toBe('handoff');
    expect(result.nextNodeId).toBe('node-handoff-target');
    expect(performHandoffSpy).toHaveBeenCalled();
    expect(harness.getEnrollment().current_node_id).toBe('node-handoff-target');
    expect(harness.getEnrollment().ai_node_session.status).toBe('handoff');
  });

  it('N. turno 10 retorna continue -> max_turns vence e segue branch max_turns', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-n',
      organizationId: 'org-n',
      nodeId: 'node-ai-1',
      contactId: 'contact-n',
      conversationId: 'conv-n',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10, // Atingiu max_turns (10)
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-n',
      enrollmentId: 'enr-n',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-10-continue',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-n',
    };

    const result = await harness.runLifecycle(input, {
      generateStructuredOutputFn: async () => ({
        reply: 'Ainda preciso de mais detalhes.',
        node_status: 'continue',
      }),
      isLeadInHandoffFn: async () => false,
    });

    expect(result.status).toBe('max_turns');
    expect(result.nextNodeId).toBe('node-maxturns-target');
    expect(harness.getEnrollment().current_node_id).toBe('node-maxturns-target');
    expect(harness.getEnrollment().ai_node_session.status).toBe('max_turns');
    expect(harness.getEnrollment().ai_node_session.completion_reason).toBe('max_turns');

    const maxTurnsEvt = harness.getEvents().find((e) => e.event_type === 'ai_node.max_turns');
    expect(maxTurnsEvt).toBeDefined();
    expect((maxTurnsEvt?.payload as Record<string, unknown>).turn_count).toBe(10);
  });

  it('O. reply contraditória de continue no último turno NÃO é enviada (outboundStatus = skipped)', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-o',
      organizationId: 'org-o',
      nodeId: 'node-ai-1',
      contactId: 'contact-o',
      conversationId: 'conv-o',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10,
        status: 'running',
      },
    });

    const sendWithLedgerSpy = vi.fn();

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-o',
      enrollmentId: 'enr-o',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-10-suppress-reply',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-o',
    };

    const result = await harness.runLifecycle(input, {
      generateStructuredOutputFn: async () => ({
        reply: 'Em que mais posso ajudar?', // Mensagem contraditória que seria confusa para o cliente
        node_status: 'continue',
      }),
      isLeadInHandoffFn: async () => false,
      sendWithLedgerFn: sendWithLedgerSpy as unknown as ExecuteAiNodeLifecycleDeps['sendWithLedgerFn'],
    });

    expect(result.status).toBe('max_turns');
    expect(result.outboundStatus).toBe('skipped');
    // sendWithLedger NÃO foi chamado: ZERO mensagens enviadas no WhatsApp!
    expect(sendWithLedgerSpy).not.toHaveBeenCalled();
  });

  it('P. retry do turno 10 -> turn_count não vira 11, max_turns não duplica', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-p',
      organizationId: 'org-p',
      nodeId: 'node-ai-1',
      contactId: 'contact-p',
      conversationId: 'conv-p',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10,
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-p',
      enrollmentId: 'enr-p',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-turn-10-retry',
      workerId: 'worker-1',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-p',
    };

    const generateLlmSpy = vi.fn().mockResolvedValue({
      reply: 'Contraditória',
      node_status: 'continue',
    });

    // 1. Primeira execução
    const res1 = await harness.runLifecycle(input, {
      generateStructuredOutputFn: generateLlmSpy,
      isLeadInHandoffFn: async () => false,
    });

    expect(res1.status).toBe('max_turns');
    expect(res1.transitionStatus).toBe('transition_fresh');
    expect(generateLlmSpy).toHaveBeenCalledTimes(1);

    // 2. Retry do mesmo turno 10
    const res2 = await harness.runLifecycle(input, {
      generateStructuredOutputFn: generateLlmSpy,
      isLeadInHandoffFn: async () => false,
    });

    expect(res2.isRetry).toBe(true);
    expect(res2.transitionStatus).toBe('transition_already_applied');
    // Zero nova chamada de LLM
    expect(generateLlmSpy).toHaveBeenCalledTimes(1);
    // turn_count permanece 10 (não virou 11)
    expect(harness.getEnrollment().ai_node_session.turn_count).toBe(10);
  });

  it('Q. 20 retries concorrentes -> exatamente uma transição max_turns', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-q',
      organizationId: 'org-q',
      nodeId: 'node-ai-1',
      contactId: 'contact-q',
      conversationId: 'conv-q',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10,
        status: 'running',
      },
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-q',
      enrollmentId: 'enr-q',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-concurrent-q',
      workerId: 'worker-q',
      leaseGeneration: 1,
      graph: baseGraphWith5Branches,
      contactId: 'contact-q',
    };

    const generateLlmSpy = vi.fn().mockResolvedValue({
      reply: 'Aguarde',
      node_status: 'continue',
    });

    // Dispara 20 retries concorrentes do turno
    const promises = Array.from({ length: 20 }, () =>
      harness.runLifecycle(
        input,
        {
          generateStructuredOutputFn: generateLlmSpy,
          isLeadInHandoffFn: async () => false,
          validateOwnershipFn: async () => ({ is_valid: true }),
        },
      ),
    );

    const results = await Promise.all(promises);

    const freshTransitions = results.filter((r) => r.transitionStatus === 'transition_fresh');
    const alreadyApplied = results.filter((r) => r.transitionStatus === 'transition_already_applied');

    expect(freshTransitions.length).toBe(1);
    expect(alreadyApplied.length).toBe(19);

    // Eventos ai_node.max_turns e ai_node.exited registrados exatamente uma vez
    const maxTurnsEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.max_turns');
    const exitedEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.exited');
    expect(maxTurnsEvents.length).toBe(1);
    expect(exitedEvents.length).toBe(1);
  });

  it('R. timeout e turno final simultâneos -> lock atômico garante somente um desfecho', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-r',
      organizationId: 'org-r',
      nodeId: 'node-ai-1',
      contactId: 'contact-r',
      conversationId: 'conv-r',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:00:00Z').toISOString(),
      session: {
        turn_count: 10,
        status: 'running',
        active_turn: null,
      },
    });

    // Simulação de corrida concorrente:
    // 1. Inbound adquire turno final 10
    const acquireRes = await acquireAiNodeInboundTurn(
      harness.mockDb,
      {
        organizationId: 'org-r',
        enrollmentId: 'enr-r',
        expectedNodeId: 'node-ai-1',
        inboundMessageId: 'msg-final-turn',
        workerId: 'worker-inbound',
      },
      {
        clock: () => new Date('2026-10-01T10:00:00Z'),
      },
    );

    expect(acquireRes.status).toBe('acquired');

    // 2. Enquanto o inbound processa, o timeout acorda no mesmo milissegundo:
    // Timeout tenta avaliar a sessão, mas vê que active_turn está em andamento (active_turn com lease ativa)
    const timeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-r',
        enrollmentId: 'enr-r',
        nodeId: 'node-ai-1',
        contactId: 'contact-r',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => new Date('2026-10-01T10:00:00Z'),
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    // Timeout não mata o turno: adia com segurança
    expect(timeoutRes.status).toBe('deferred_active_turn');

    // 3. Inbound conclui turno 10 transicionando para max_turns
    const inboundRes = await harness.runLifecycle(
      {
        organizationId: 'org-r',
        enrollmentId: 'enr-r',
        nodeId: 'node-ai-1',
        inboundMessageId: 'msg-final-turn',
        workerId: 'worker-inbound',
        leaseGeneration: acquireRes.status === 'acquired' ? acquireRes.lease_generation : 1,
        graph: baseGraphWith5Branches,
        contactId: 'contact-r',
      },
      {
        generateStructuredOutputFn: async () => ({
          reply: 'Mais informações',
          node_status: 'continue',
        }),
        isLeadInHandoffFn: async () => false,
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    expect(inboundRes.status).toBe('max_turns');
    expect(harness.getEnrollment().current_node_id).toBe('node-maxturns-target');

    // 4. Timeout adiado acorda mais tarde
    const laterTimeoutRes = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-r',
        enrollmentId: 'enr-r',
        nodeId: 'node-ai-1',
        contactId: 'contact-r',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => new Date('2026-10-01T10:05:00Z'),
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    // Timeout posterior vê que o nó já mudou para 'node-maxturns-target'
    expect(laterTimeoutRes.status).toBe('node_changed');

    // NUNCA desfechos conflitantes simultâneos: somente max_turns venceu
    expect(harness.getEnrollment().ai_node_session.status).toBe('max_turns');
  });

  // =========================================================================
  // SEÇÃO 3: AUDITORIA DE REENTRADA / LOOP E CONCORRÊNCIA DE RETRIES (S a U)
  // =========================================================================

  it('S. Reentrada no mesmo ai_node após loop -> novo timeout legítimo com chaves distintas por started_at', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-s-loop',
      organizationId: 'org-s',
      nodeId: 'node-ai-1',
      contactId: 'contact-s',
      conversationId: 'conv-s',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:00:00Z').toISOString(),
      session: {
        started_at: '2026-10-01T09:00:00.000Z', // Primeira visita às 09:00
        status: 'running',
        active_turn: null,
      },
    });

    // 1. Primeira visita sofre timeout às 10:00
    const timeout1 = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-s',
        enrollmentId: 'enr-s-loop',
        nodeId: 'node-ai-1',
        contactId: 'contact-s',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => new Date('2026-10-01T10:00:00Z'),
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    expect(timeout1.status).toBe('timeout');
    expect(timeout1.transitionStatus).toBe('transition_fresh');
    expect(timeout1.nextNodeId).toBe('node-timeout-target');
    expect(harness.getEnrollment().current_node_id).toBe('node-timeout-target');

    // 2. Fluxo caminha por nós intermediários e faz um loop de volta para 'node-ai-1'
    // Simulando a nova entrada no node-ai-1 com nova sessão e novo started_at:
    const enr = harness.getEnrollment();
    enr.current_node_id = 'node-ai-1';
    enr.status = 'active';
    enr.ai_node_session = {
      node_id: 'node-ai-1',
      mode: 'custom_prompt',
      turn_count: 0,
      started_at: '2026-10-01T15:00:00.000Z', // Segunda visita às 15:00!
      status: 'running',
      active_turn: null,
      timeout_at: '2026-10-01T16:00:00.000Z',
      extracted_data: {},
      media_summary: { images_count: 0, audios_count: 0, documents_count: 0, last_media_ids: [] },
    };
    enr.next_eval_at = '2026-10-01T16:00:00.000Z';

    // 3. Segunda visita sofre novo timeout legítimo às 16:00
    const timeout2 = await executeAiNodeTimeout(
      harness.mockDb,
      {
        organizationId: 'org-s',
        enrollmentId: 'enr-s-loop',
        nodeId: 'node-ai-1',
        contactId: 'contact-s',
        graph: baseGraphWith5Branches,
      },
      {
        clock: () => new Date('2026-10-01T16:00:00Z'),
        advanceEnrollmentFn: harness.advanceEnrollmentFn,
      },
    );

    // O segundo timeout NÃO colide com o primeiro! Transiciona normalmente como 'transition_fresh'!
    expect(timeout2.status).toBe('timeout');
    expect(timeout2.transitionStatus).toBe('transition_fresh');
    expect(timeout2.nextNodeId).toBe('node-timeout-target');
    expect(harness.getEnrollment().current_node_id).toBe('node-timeout-target');

    // Dois eventos ai_node.timeout distintos gravados com sucesso
    const timeoutEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.timeout');
    expect(timeoutEvents.length).toBe(2);

    // Dois eventos ai_node.exited distintos com tokens diferentes
    const exitedEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.exited');
    expect(exitedEvents.length).toBe(2);
    expect(exitedEvents[0]!.idempotency_key).toContain('2026-10-01T09:00:00.000Z');
    expect(exitedEvents[1]!.idempotency_key).toContain('2026-10-01T15:00:00.000Z');
  });

  it('T. Mesma visita com 20 retries concorrentes de timeout -> exatamente 1 transição fresh e 19 already_applied', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-t-concurrent',
      organizationId: 'org-t',
      nodeId: 'node-ai-1',
      contactId: 'contact-t',
      conversationId: 'conv-t',
      graph: baseGraphWith5Branches,
      nextEvalAt: new Date('2026-10-01T10:00:00Z').toISOString(),
      session: {
        started_at: '2026-10-01T09:00:00.000Z',
        status: 'running',
        active_turn: null,
      },
    });

    const promises = Array.from({ length: 20 }, () =>
      executeAiNodeTimeout(
        harness.mockDb,
        {
          organizationId: 'org-t',
          enrollmentId: 'enr-t-concurrent',
          nodeId: 'node-ai-1',
          contactId: 'contact-t',
          graph: baseGraphWith5Branches,
        },
        {
          clock: () => new Date('2026-10-01T10:00:00Z'),
          advanceEnrollmentFn: harness.advanceEnrollmentFn,
        },
      ),
    );

    const results = await Promise.all(promises);

    const fresh = results.filter((r) => r.transitionStatus === 'transition_fresh');
    const alreadyApplied = results.filter((r) => r.transitionStatus === 'transition_already_applied' || r.status === 'node_changed');

    expect(fresh.length).toBe(1);
    expect(alreadyApplied.length).toBe(19);

    // Exatamente 1 evento ai_node.timeout e 1 evento ai_node.exited
    const timeoutEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.timeout');
    const exitedEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.exited');
    expect(timeoutEvents.length).toBe(1);
    expect(exitedEvents.length).toBe(1);

    // advanceEnrollment chamado exatamente 1x
    expect(harness.getAdvanceCalls().length).toBe(1);
  });

  it('U. Reentrada no mesmo ai_node após loop -> novo max_turns legítimo (inboundMessageId distinto)', async () => {
    const harness = createTimeoutAndMaxTurnsHarness({
      enrollmentId: 'enr-u-loop',
      organizationId: 'org-u',
      nodeId: 'node-ai-1',
      contactId: 'contact-u',
      conversationId: 'conv-u',
      graph: baseGraphWith5Branches,
      session: {
        turn_count: 10,
        status: 'running',
      },
    });

    // 1. Primeiro max_turns com msg-inbound-1
    const res1 = await harness.runLifecycle(
      {
        organizationId: 'org-u',
        enrollmentId: 'enr-u-loop',
        nodeId: 'node-ai-1',
        inboundMessageId: 'msg-inbound-1',
        workerId: 'w-1',
        leaseGeneration: 1,
        graph: baseGraphWith5Branches,
        contactId: 'contact-u',
      },
      {
        generateStructuredOutputFn: async () => ({
          reply: 'Mais detalhes',
          node_status: 'continue',
        }),
        isLeadInHandoffFn: async () => false,
      },
    );

    expect(res1.status).toBe('max_turns');
    expect(res1.transitionStatus).toBe('transition_fresh');
    expect(harness.getEnrollment().current_node_id).toBe('node-maxturns-target');

    // 2. Loop de volta para o nó com nova sessão
    const enr = harness.getEnrollment();
    enr.current_node_id = 'node-ai-1';
    enr.status = 'active';
    enr.ai_node_session = {
      node_id: 'node-ai-1',
      mode: 'custom_prompt',
      turn_count: 10, // Novo ciclo já atingiu o limite da nova visita
      started_at: '2026-10-01T18:00:00.000Z',
      status: 'running',
      active_turn: null,
      extracted_data: {},
      media_summary: { images_count: 0, audios_count: 0, documents_count: 0, last_media_ids: [] },
    };

    // 3. Segundo max_turns com msg-inbound-2
    const res2 = await harness.runLifecycle(
      {
        organizationId: 'org-u',
        enrollmentId: 'enr-u-loop',
        nodeId: 'node-ai-1',
        inboundMessageId: 'msg-inbound-2',
        workerId: 'w-2',
        leaseGeneration: 1,
        graph: baseGraphWith5Branches,
        contactId: 'contact-u',
      },
      {
        generateStructuredOutputFn: async () => ({
          reply: 'Mais dados',
          node_status: 'continue',
        }),
        isLeadInHandoffFn: async () => false,
      },
    );

    expect(res2.status).toBe('max_turns');
    expect(res2.transitionStatus).toBe('transition_fresh');

    // Dois eventos ai_node.max_turns registrados sem colisão
    const maxTurnsEvents = harness.getEvents().filter((e) => e.event_type === 'ai_node.max_turns');
    expect(maxTurnsEvents.length).toBe(2);
    expect(maxTurnsEvents[0]!.idempotency_key).toContain('msg-inbound-1');
    expect(maxTurnsEvents[1]!.idempotency_key).toContain('msg-inbound-2');
  });
});

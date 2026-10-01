import { describe, it, expect, vi } from 'vitest';
import {
  executeAiNodeLifecycle,
  type ExecuteAiNodeLifecycleInput,
  type ExecuteAiNodeLifecycleDeps,
} from '@/lib/followup/ai-node-lifecycle';
import {
  type DbPoolLike,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import type { FlowGraph } from '@/lib/followup/graph-schema';
import {
  avancarEnrollmentAtivo,
  type AdminClient,
  type TickDeps,
  type EnrollmentPatch,
} from '@/lib/followup/engine';
import type { EnrollmentRow, EnrollmentStatus, EnrollmentOutcome } from '@/lib/followup/node-handlers';

interface MockEnrollmentData {
  id: string;
  organization_id: string;
  current_node_id: string;
  contact_id: string;
  conversation_id: string | null;
  pointer_id?: string;
  version_id: string;
  status: EnrollmentStatus;
  steps_taken: number;
  outcome: EnrollmentOutcome | null;
  cancel_reason?: string | null;
  completed_at: string | null;
  started_at?: string;
  updated_at?: string;
  ai_node_session: AiNodeSession;
  graph: FlowGraph;
  next_eval_at?: string;
  claimed_until?: string | null;
}

interface MockDbState {
  enrollments: Map<string, MockEnrollmentData>;
  events: Array<Record<string, unknown>>;
  sendLedger: Map<string, Record<string, unknown>>;
  contacts: Map<string, Record<string, unknown>>;
  conversations: Map<string, Record<string, unknown>>;
}

const STAGE_QUALIFICADO_UUID = '11111111-1111-4111-8111-111111111111';
const STAGE_AUTO_UUID = '22222222-2222-4222-8222-222222222222';
const STAGE_POS_IA_UUID = '33333333-3333-4333-8333-333333333333';

function createMockAdminClient(overrides: Partial<AdminClient> = {}): AdminClient {
  return {
    claimDueEnrollments: vi.fn(),
    loadFlowGraph: vi.fn().mockResolvedValue(null),
    loadLeadFacts: vi.fn().mockResolvedValue({
      lead_stage: 'stage-inicial',
      tags: [],
    }),
    loadEnrollmentEvents: vi.fn().mockResolvedValue([]),
    loadLastInboundBody: vi.fn().mockResolvedValue(null),
    insertEnrollmentEvent: vi.fn().mockResolvedValue({ inserted: true }),
    updateEnrollment: vi.fn().mockResolvedValue(undefined),
    loadFlowPointerName: vi.fn().mockResolvedValue('Fluxo'),
    insertDeadInboxItem: vi.fn().mockResolvedValue(undefined),
    persistirRespostaFollowup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMiniFlowMockDb(initial: {
  enrollmentId: string;
  organizationId: string;
  nodeId: string;
  contactId: string;
  conversationId: string;
  graph: FlowGraph;
  inboundMessageId?: string;
  session?: Partial<AiNodeSession>;
}) {
  const fullSession: AiNodeSession = {
    node_id: initial.nodeId,
    mode: 'custom_prompt',
    turn_count: 0,
    started_at: new Date().toISOString(),
    media_summary: {
      images_count: 0,
      audios_count: 0,
      documents_count: 0,
      last_media_ids: [],
    },
    active_turn: {
      inbound_message_id: initial.inboundMessageId ?? 'inbound-default',
      worker_id: 'worker-1',
      claimed_at: new Date().toISOString(),
      lease_until: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      lease_generation: 1,
    },
    extracted_data: {},
    status: 'running',
    ...initial.session,
  };

  const state: MockDbState = {
    enrollments: new Map(),
    events: [],
    sendLedger: new Map(),
    contacts: new Map(),
    conversations: new Map(),
  };

  state.enrollments.set(initial.enrollmentId, {
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
  });

  state.contacts.set(initial.contactId, {
    id: initial.contactId,
    organization_id: initial.organizationId,
    force_human: false,
    name: 'Lead Teste',
    tags: [],
    lead_stage: 'stage-inicial',
  });

  state.conversations.set(initial.conversationId, {
    id: initial.conversationId,
    organization_id: initial.organizationId,
    contact_id: initial.contactId,
    status: 'ai_handling',
    bot_silenced_until: null,
  });

  const mockDb = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const cleanSql = sql.trim().toUpperCase();

      if (cleanSql.startsWith('BEGIN') || cleanSql.startsWith('COMMIT') || cleanSql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      // SELECT enrollment com join em flow_versions
      if (cleanSql.includes('FROM FOLLOWUP_ENROLLMENTS')) {
        const enr = state.enrollments.get(initial.enrollmentId);
        if (cleanSql.includes('FOR UPDATE') || cleanSql.includes('CURRENT_NODE_ID')) {
          return { rows: enr ? [{ ...enr, ai_node_session: JSON.parse(JSON.stringify(enr.ai_node_session)) }] : [] };
        }
        return { rows: enr ? [{ ...enr, ai_node_session: JSON.parse(JSON.stringify(enr.ai_node_session)) }] : [] };
      }

      // INSERT / ON CONFLICT em followup_enrollment_events
      if (cleanSql.includes('INSERT INTO FOLLOWUP_ENROLLMENT_EVENTS')) {
        const orgId = params[0];
        const enrId = params[1];
        const nodeId = params[2];
        const eventType = params[3];
        const payload = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4];
        const idempotencyKey = params[5];
        const createdAt = params[6];

        if (idempotencyKey) {
          const exists = state.events.find(
            (e) => e.enrollment_id === enrId && e.idempotency_key === idempotencyKey,
          );
          if (exists) {
            return { rows: [] }; // ON CONFLICT DO NOTHING
          }
        }

        const newEvent = {
          id: `evt-${state.events.length + 1}`,
          organization_id: orgId,
          enrollment_id: enrId,
          node_id: nodeId,
          event_type: eventType,
          payload,
          idempotency_key: idempotencyKey,
          created_at: createdAt,
        };
        state.events.push(newEvent);
        return { rows: [newEvent] };
      }

      // SELECT em followup_enrollment_events
      if (cleanSql.includes('FROM FOLLOWUP_ENROLLMENT_EVENTS')) {
        const enrId = params[0];
        const key = params[1];
        const found = state.events.find((e) => e.enrollment_id === enrId && e.idempotency_key === key);
        return { rows: found ? [found] : [] };
      }

      // Suporte a send_ledger
      if (cleanSql.includes('INSERT INTO SEND_LEDGER')) {
        const orgId = params[0];
        const contactId = params[1];
        const jobId = params[2];
        const seq = params[3];
        const bodyHash = params[4];
        const ledgerKey = `${orgId}:${jobId}:${seq}`;
        const newLedgerId = `ledger-${state.sendLedger.size + 1}`;
        const row = {
          id: newLedgerId,
          organization_id: orgId,
          contact_id: contactId,
          job_id: jobId,
          seq,
          body_hash: bodyHash,
          status: 'requested',
          crm_message_id: null,
        };
        state.sendLedger.set(ledgerKey, row);
        return { rows: [{ id: newLedgerId }] };
      }

      if (cleanSql.includes('SELECT * FROM SEND_LEDGER')) {
        const orgId = params[0];
        const jobId = params[1];
        const seq = params[2];
        const row = state.sendLedger.get(`${orgId}:${jobId}:${seq}`);
        return { rows: row ? [row] : [] };
      }

      if (cleanSql.includes('UPDATE SEND_LEDGER')) {
        return { rows: [] };
      }

      if (cleanSql.includes('SELECT ID,STATUS FROM MESSAGES')) {
        return { rows: [] };
      }

      // SELECT em followup_enrollments
      if (cleanSql.includes('FROM FOLLOWUP_ENROLLMENTS') && cleanSql.startsWith('SELECT')) {
        const idToFind = String(params[1] ?? params[0] ?? initial.enrollmentId);
        const enr = state.enrollments.get(idToFind);
        if (enr) {
          return { rows: [{ current_node_id: enr.current_node_id, status: enr.status, steps_taken: enr.steps_taken }] };
        }
        return { rows: [] };
      }

      // UPDATE followup_enrollments
      if (cleanSql.includes('UPDATE FOLLOWUP_ENROLLMENTS')) {
        const enr = state.enrollments.get(initial.enrollmentId);
        if (enr) {
          if (cleanSql.includes('SET CURRENT_NODE_ID = $1')) {
            enr.current_node_id = params[0] as string;
            enr.steps_taken = (Number(enr.steps_taken) || 0) + 1;
            enr.ai_node_session = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
            enr.next_eval_at = params[2] as string;
            enr.status = 'active';
            enr.claimed_until = null;
            enr.updated_at = params[2] as string;
          } else if (cleanSql.includes("SET STATUS = 'COMPLETED'")) {
            enr.status = 'completed';
            enr.outcome = params[0] as EnrollmentOutcome;
            enr.completed_at = params[1] as string;
            enr.ai_node_session = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
          } else if (cleanSql.includes("SET STATUS = 'PAUSED_HANDOFF'")) {
            enr.status = 'paused_handoff';
            enr.outcome = 'handoff';
            if (cleanSql.includes('AI_NODE_SESSION = $1')) {
              enr.ai_node_session = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
              enr.updated_at = params[1] as string;
            } else {
              enr.updated_at = params[0] as string;
            }
          } else if (cleanSql.includes('SET AI_NODE_SESSION = $1')) {
            enr.ai_node_session = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
            enr.updated_at = params[1] as string;
          }
        }
        return { rows: [enr] };
      }

      if (cleanSql.includes('FROM CONTACTS')) {
        const contact = state.contacts.get(initial.contactId);
        return { rows: contact ? [contact] : [] };
      }

      if (cleanSql.includes('FROM CONVERSATIONS')) {
        const conv = state.conversations.get(initial.conversationId);
        return { rows: conv ? [conv] : [] };
      }

      return { rows: [] };
    }),
    state,
    getEnrollment: () => state.enrollments.get(initial.enrollmentId)!,
  };

  return mockDb;
}

describe('Fase 4.1: Auditoria do Ciclo de Transição e Continuação Automática do Fluxo', () => {
  const orgId = 'org-flow-41';
  const enrId = 'enr-flow-41';
  const contactId = 'contact-flow-41';
  const convId = 'conv-flow-41';

  // =========================================================================
  // CENÁRIO A: message_text -> ai_node -> completed -> stage_move -> message_text
  // Esperado: todos os nós após IA executam automaticamente via motor canônico.
  // =========================================================================
  it('A: ai_node completed -> stage_move -> message_text (continuação automática em cascata)', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-msg-pre',
          type: 'message_text',
          label: 'Boas Vindas',
          position: { x: 0, y: 0 },
          config: { body: 'Olá!' },
        },
        {
          id: 'node-ai-1',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 100, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Atenda o lead e qualifique',
          },
        },
        {
          id: 'node-stage-move-1',
          type: 'stage_move',
          label: 'Qualificar Lead',
          position: { x: 200, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-msg-pos',
          type: 'message_text',
          label: 'Mensagem Pós Qualificação',
          position: { x: 300, y: 0 },
          config: { body: 'Parabéns, você foi qualificado!' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-msg-pre', target: 'node-ai-1', priority: 0, condition: { type: 'always' } },
        { id: 'e2', source: 'node-ai-1', target: 'node-stage-move-1', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e3', source: 'node-stage-move-1', target: 'node-msg-pos', priority: 0, condition: { type: 'always' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-1',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-100',
    });

    let stageMovedTo: string | null = null;

    const engineAdminClient = createMockAdminClient({
      loadFlowGraph: vi.fn().mockResolvedValue(graph),
      updateEnrollment: vi.fn().mockImplementation((_id, _org, patch: EnrollmentPatch) => {
        const enr = mockDb.state.enrollments.get(enrId);
        if (enr && patch.current_node_id) {
          enr.current_node_id = patch.current_node_id;
        }
        return Promise.resolve();
      }),
      updateLeadStage: vi.fn().mockImplementation((opts) => {
        stageMovedTo = opts.stage_id;
        return Promise.resolve();
      }),
    });

    const engineTickDeps: TickDeps = {
      db: engineAdminClient,
      clock: () => new Date('2026-09-30T22:00:00.000Z'),
      enqueueJob: vi.fn().mockResolvedValue(undefined),
    };

    // advanceEnrollmentFn conecta o motor canônico
    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, _organizationId: string, nextNodeId: string) => {
      const enr = mockDb.state.enrollments.get(enrollmentId)!;
      const enrollmentRow: EnrollmentRow = {
        id: enr.id,
        organization_id: enr.organization_id,
        pointer_id: enr.pointer_id ?? 'pt-1',
        version_id: enr.version_id,
        contact_id: enr.contact_id,
        conversation_id: enr.conversation_id ?? null,
        current_node_id: nextNodeId,
        status: 'active',
        steps_taken: enr.steps_taken,
        next_eval_at: new Date().toISOString(),
        outcome: null,
        cancel_reason: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        updated_at: new Date().toISOString(),
        claimed_until: null,
        last_error: null,
        attempts: 0,
        max_attempts: 3,
        service_boundary: null,
      };
      await avancarEnrollmentAtivo(engineTickDeps, enrollmentRow);
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-1',
      inboundMessageId: 'inbound-100',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
      inboundText: 'Quero fechar negócio!',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-1', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Ótimo, vamos qualificar!',
            node_status: 'completed',
            outcome: 'qualificado',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const result = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    expect(result.status).toBe('completed');
    expect(result.nextNodeId).toBe('node-stage-move-1');
    expect(result.transitionStatus).toBe('transition_fresh');

    // 1. Confirma que advanceEnrollmentFn foi acionado com o target correto
    expect(advanceEnrollmentSpy).toHaveBeenCalledWith(enrId, orgId, 'node-stage-move-1');

    // 2. Confirma que stage_move executou automaticamente
    expect(stageMovedTo).toBe(STAGE_QUALIFICADO_UUID);

    // 3. Confirma que o motor canônico avançou em cascata para message_text sem esperar novo inbound!
    expect(engineTickDeps.enqueueJob).toHaveBeenCalled();
  });

  // =========================================================================
  // CENÁRIO B: ai_node -> deterministic_completed -> tag -> message_text
  // Esperado: Zero LLM e continuação automática no motor.
  // =========================================================================
  it('B: ai_node deterministic_completed -> tag -> message_text (zero LLM e avanço automático)', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-deterministic',
          type: 'ai_node',
          label: 'Receber Fotos',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Receba 2 fotos para validação',
            deterministic_conditions: {
              min_images: 2,
            },
          },
        },
        {
          id: 'node-tag-docs',
          type: 'tag',
          label: 'Tag Fotos OK',
          position: { x: 100, y: 0 },
          config: { action: 'add', tags: ['fotos-recebidas'] },
        },
        {
          id: 'node-msg-docs-ok',
          type: 'message_text',
          label: 'Msg Docs Recebidos',
          position: { x: 200, y: 0 },
          config: { body: 'Documentos recebidos com sucesso!' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-deterministic', target: 'node-tag-docs', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-tag-docs', target: 'node-msg-docs-ok', priority: 0, condition: { type: 'always' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-deterministic',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-img-2',
      session: {
        status: 'running',
        media_summary: {
          images_count: 2, // Atende min_images: 2
          audios_count: 0,
          documents_count: 0,
          last_media_ids: ['img-1', 'img-2'],
        },
      },
    });

    let tagAdded: string[] | null = null;

    const engineAdminClient = createMockAdminClient({
      loadFlowGraph: vi.fn().mockResolvedValue(graph),
      updateLeadTags: vi.fn().mockImplementation((opts) => {
        tagAdded = opts.tags;
        return Promise.resolve();
      }),
    });

    const engineTickDeps: TickDeps = {
      db: engineAdminClient,
      clock: () => new Date('2026-09-30T22:00:00.000Z'),
      enqueueJob: vi.fn().mockResolvedValue(undefined),
    };

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, _orgId: string, nextNodeId: string) => {
      const enr = mockDb.state.enrollments.get(enrollmentId)!;
      const enrollmentRow: EnrollmentRow = {
        id: enr.id,
        organization_id: enr.organization_id,
        pointer_id: enr.pointer_id ?? 'pt-1',
        version_id: enr.version_id,
        contact_id: enr.contact_id,
        conversation_id: enr.conversation_id ?? null,
        current_node_id: nextNodeId,
        status: 'active',
        steps_taken: enr.steps_taken,
        next_eval_at: new Date().toISOString(),
        outcome: null,
        cancel_reason: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        updated_at: new Date().toISOString(),
        claimed_until: null,
        last_error: null,
        attempts: 0,
        max_attempts: 3,
        service_boundary: null,
      };
      await avancarEnrollmentAtivo(engineTickDeps, enrollmentRow);
    });

    const runModelCallSpy = vi.fn();

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-deterministic',
      inboundMessageId: 'inbound-img-2',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      runModelCallFn: runModelCallSpy,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    };

    const result = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    expect(result.status).toBe('deterministic_completed');
    expect(result.nextNodeId).toBe('node-tag-docs');
    expect(result.transitionStatus).toBe('transition_fresh');

    // Zero chamadas ao LLM
    expect(runModelCallSpy).not.toHaveBeenCalled();

    // Continuação automática chamou advanceEnrollmentFn
    expect(advanceEnrollmentSpy).toHaveBeenCalledWith(enrId, orgId, 'node-tag-docs');

    // Tag aplicada e mensagem pos-tag enfileirada no motor canônico
    expect(tagAdded).toEqual(['fotos-recebidas']);
    expect(engineTickDeps.enqueueJob).toHaveBeenCalled();
  });

  // =========================================================================
  // CENÁRIO C: ai_node -> runtime error -> branch error -> message_text fallback
  // Esperado: Fallback realmente executa via motor canônico.
  // =========================================================================
  it('C: ai_node runtime error -> branch error -> message_text fallback (fallback executa)', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-failing',
          type: 'ai_node',
          label: 'Atendimento Falho',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Prompt teste',
          },
        },
        {
          id: 'node-fallback-msg',
          type: 'message_text',
          label: 'Fallback Msg',
          position: { x: 100, y: 0 },
          config: { body: 'Desculpe, ocorreu uma instabilidade. Já estamos verificando!' },
        },
      ],
      edges: [
        { id: 'e-err', source: 'node-ai-failing', target: 'node-fallback-msg', priority: 1, condition: { type: 'branch', branch_id: 'error' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-failing',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-fail-1',
    });

    let fallbackEnqueued = false;

    const engineAdminClient = createMockAdminClient({
      loadFlowGraph: vi.fn().mockResolvedValue(graph),
    });

    const engineTickDeps: TickDeps = {
      db: engineAdminClient,
      clock: () => new Date('2026-09-30T22:00:00.000Z'),
      enqueueJob: vi.fn().mockImplementation(() => {
        fallbackEnqueued = true;
        return Promise.resolve();
      }),
    };

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, _orgId: string, nextNodeId: string) => {
      const enr = mockDb.state.enrollments.get(enrollmentId)!;
      const enrollmentRow: EnrollmentRow = {
        id: enr.id,
        organization_id: enr.organization_id,
        pointer_id: enr.pointer_id ?? 'pt-1',
        version_id: enr.version_id,
        contact_id: enr.contact_id,
        conversation_id: enr.conversation_id ?? null,
        current_node_id: nextNodeId,
        status: 'active',
        steps_taken: enr.steps_taken,
        next_eval_at: new Date().toISOString(),
        outcome: null,
        cancel_reason: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        updated_at: new Date().toISOString(),
        claimed_until: null,
        last_error: null,
        attempts: 0,
        max_attempts: 3,
        service_boundary: null,
      };
      await avancarEnrollmentAtivo(engineTickDeps, enrollmentRow);
    });

    const runModelCallSpy = vi.fn().mockRejectedValueOnce(new Error('llm_service_unavailable_503'));

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-failing',
      inboundMessageId: 'inbound-fail-1',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
      inboundText: 'Olá',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      runModelCallFn: runModelCallSpy,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    };

    const result = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    expect(result.status).toBe('error');
    expect(result.nextNodeId).toBe('node-fallback-msg');
    expect(result.transitionStatus).toBe('transition_fresh');

    // advanceEnrollmentFn foi chamado para o nó de fallback
    expect(advanceEnrollmentSpy).toHaveBeenCalledWith(enrId, orgId, 'node-fallback-msg');

    // O nó de fallback (message_text) realmente executou no motor canônico!
    expect(fallbackEnqueued).toBe(true);
  });

  // =========================================================================
  // CENÁRIO D: ai_node -> semantic handoff -> branch handoff existente
  // Confirmar que o handoff semântico NÃO é neutralizado pela barreira humana
  // e avança pela branch configurada.
  // =========================================================================
  it('D: ai_node semantic handoff -> branch handoff existente (barreira não neutraliza branch)', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-handoff',
          type: 'ai_node',
          label: 'Atendimento com Handoff',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Atenda o lead e transfira quando pedir atendente',
          },
        },
        {
          id: 'node-tag-handoff',
          type: 'tag',
          label: 'Tag Handoff',
          position: { x: 100, y: 0 },
          config: { action: 'add', tags: ['aguardando-atendente'] },
        },
        {
          id: 'node-msg-handoff-pos',
          type: 'message_text',
          label: 'Aviso Transferencia',
          position: { x: 200, y: 0 },
          config: { body: 'Aguarde um momento enquanto chamamos o atendente.' },
        },
      ],
      edges: [
        { id: 'e-handoff', source: 'node-ai-handoff', target: 'node-tag-handoff', priority: 1, condition: { type: 'branch', branch_id: 'handoff' } },
        { id: 'e-always-tag', source: 'node-tag-handoff', target: 'node-msg-handoff-pos', priority: 0, condition: { type: 'always' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-handoff',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-handoff-1',
    });

    let handoffTagApplied = false;

    const engineAdminClient = createMockAdminClient({
      loadFlowGraph: vi.fn().mockResolvedValue(graph),
      updateLeadTags: vi.fn().mockImplementation((opts) => {
        if (opts.tags.includes('aguardando-atendente')) {
          handoffTagApplied = true;
        }
        return Promise.resolve();
      }),
    });

    const engineTickDeps: TickDeps = {
      db: engineAdminClient,
      clock: () => new Date('2026-09-30T22:00:00.000Z'),
      enqueueJob: vi.fn(),
    };

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, _orgId: string, nextNodeId: string) => {
      const enr = mockDb.state.enrollments.get(enrollmentId)!;
      const enrollmentRow: EnrollmentRow = {
        id: enr.id,
        organization_id: enr.organization_id,
        pointer_id: enr.pointer_id ?? 'pt-1',
        version_id: enr.version_id,
        contact_id: enr.contact_id,
        conversation_id: enr.conversation_id ?? null,
        current_node_id: nextNodeId,
        status: 'active',
        steps_taken: enr.steps_taken,
        next_eval_at: new Date().toISOString(),
        outcome: null,
        cancel_reason: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        updated_at: new Date().toISOString(),
        claimed_until: null,
        last_error: null,
        attempts: 0,
        max_attempts: 3,
        service_boundary: null,
      };
      await avancarEnrollmentAtivo(engineTickDeps, enrollmentRow);
    });

    const performHandoffSpy = vi.fn().mockResolvedValue(undefined);

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-handoff',
      inboundMessageId: 'inbound-handoff-1',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
      inboundText: 'Quero falar com um atendente humano',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      performHumanHandoffFn: performHandoffSpy,
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-2', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Vou te transferir para um de nossos especialistas agora mesmo.',
            node_status: 'handoff',
            outcome: 'cliente_pediu_humano',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const result = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    // O status do resultado é 'handoff' e a branch handoff foi seguida
    expect(result.status).toBe('handoff');
    expect(result.nextNodeId).toBe('node-tag-handoff');
    expect(result.transitionStatus).toBe('transition_fresh');

    // performHumanHandoff foi chamado
    expect(performHandoffSpy).toHaveBeenCalledTimes(1);

    // advanceEnrollmentFn foi chamado para o target da branch handoff
    expect(advanceEnrollmentSpy).toHaveBeenCalledWith(enrId, orgId, 'node-tag-handoff');

    // O motor canônico executou o próximo nó da branch handoff
    expect(handoffTagApplied).toBe(true);
  });

  // =========================================================================
  // CENÁRIO E: humano assume externamente durante IA -> zero transição automática
  // Esperado: HUMANO > IA, automação abortada, paused_handoff, zero transição.
  // =========================================================================
  it('E: humano assume externamente durante IA -> transição abortada (HUMANO > IA)', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-active',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Atenda o lead',
          },
        },
        {
          id: 'node-stage-move-auto',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_AUTO_UUID },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-active', target: 'node-stage-move-auto', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-active',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-human-takeover-1',
    });

    const advanceEnrollmentSpy = vi.fn();
    const sendOutboundSpy = vi.fn();

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-active',
      inboundMessageId: 'inbound-human-takeover-1',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
      inboundText: 'Olá',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: sendOutboundSpy,
      // Atendente humano assumiu a conversa durante a execução da IA!
      isLeadInHandoffFn: vi.fn().mockResolvedValue(true),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Mensagem que NÃO deve ser enviada',
            node_status: 'completed',
            outcome: 'completo',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const result = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    expect(result.status).toBe('aborted_human_takeover');
    expect(result.transitionStatus).toBe('skipped');

    // Zero envio de outbound
    expect(sendOutboundSpy).not.toHaveBeenCalled();

    // NENHUMA transição automática foi executada
    expect(advanceEnrollmentSpy).not.toHaveBeenCalled();

    // Enrollment foi colocado em paused_handoff
    const enr = mockDb.getEnrollment();
    expect(enr.status).toBe('paused_handoff');
    expect(enr.current_node_id).toBe('node-ai-active'); // Nó NÃO foi alterado
  });

  // =========================================================================
  // CENÁRIO F: crash após transition -> retry -> próximos nodes não duplicam efeitos
  // Esperado: transitionStatus = 'transition_already_applied', zero duplicação.
  // =========================================================================
  it('F: crash após transition -> retry -> transição já aplicada e zero duplicação', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-crash',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Atenda o lead',
          },
        },
        {
          id: 'node-stage-move-target',
          type: 'stage_move',
          label: 'Próximo Estágio',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_POS_IA_UUID },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-crash', target: 'node-stage-move-target', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
      ],
    };

    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: 'node-ai-crash',
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId: 'inbound-crash-test',
    });

    const advanceEnrollmentSpy = vi.fn();

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-crash',
      inboundMessageId: 'inbound-crash-test',
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: mockDb.getEnrollment().ai_node_session,
      inboundText: 'Quero avançar',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-crash-test', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Concluído com sucesso!',
            node_status: 'completed',
            outcome: 'sucesso',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    // 1ª Execução: fresh transition
    const firstResult = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);
    expect(firstResult.status).toBe('completed');
    expect(firstResult.transitionStatus).toBe('transition_fresh');
    expect(advanceEnrollmentSpy).toHaveBeenCalledTimes(1);

    // O avanço completou o fluxo com sucesso (status = 'completed')
    mockDb.state.enrollments.get(enrId)!.status = 'completed';
    advanceEnrollmentSpy.mockClear();

    // 2ª Execução (Retry da mensagem com fluxo já completado):
    const retryResult = await executeAiNodeLifecycle(mockDb as unknown as DbPoolLike, input, deps);

    expect(retryResult.status).toBe('completed');
    expect(retryResult.transitionStatus).toBe('transition_already_applied');

    // advanceEnrollmentFn NÃO foi disparado novamente pelo lifecycle
    expect(advanceEnrollmentSpy).not.toHaveBeenCalled();

    // Eventos ai_node.exited contam exatamente 1 (sem duplicação)
    const exitEvents = mockDb.state.events.filter((e) => e.event_type === 'ai_node.exited');
    expect(exitEvents).toHaveLength(1);
  });
});

describe('Fase 4.1+: Auditoria Final de Durabilidade e Proteção da Branch Handoff', () => {
  const orgId = 'org-durability-41';
  const enrId = 'enr-durability-41';
  const contactId = 'contact-durability-41';
  const convId = 'conv-durability-41';

  function createDurabilityHarness(
    graph: FlowGraph,
    overrides: { inHandoff?: boolean; inboundMessageId?: string } = {},
  ) {
    const inboundMessageId = overrides.inboundMessageId ?? 'inbound-durability-1';
    const mockDb = createMiniFlowMockDb({
      enrollmentId: enrId,
      organizationId: orgId,
      nodeId: graph.nodes[0]!.id,
      contactId,
      conversationId: convId,
      graph,
      inboundMessageId,
    });

    const sideEffects = {
      stagesMoved: [] as string[],
      tagsApplied: [] as string[],
      messagesEnqueued: [] as string[],
      advanceCallCount: 0,
    };

    const engineAdminClient = createMockAdminClient({
      loadFlowGraph: vi.fn().mockResolvedValue(graph),
      updateLeadStage: vi.fn().mockImplementation(async (opts) => {
        sideEffects.stagesMoved.push(opts.stage_id);
      }),
      updateLeadTags: vi.fn().mockImplementation(async (opts) => {
        sideEffects.tagsApplied.push(...opts.tags);
      }),
      updateEnrollment: vi.fn().mockImplementation(async (id: string, _orgId: string, patch: EnrollmentPatch) => {
        const enr = mockDb.state.enrollments.get(id);
        if (enr) {
          Object.assign(enr, patch);
        }
      }),
      insertEnrollmentEvent: vi.fn().mockImplementation(async (evt: { event_type: string; node_id?: string; payload?: unknown; idempotency_key?: string }) => {
        mockDb.state.events.push(evt as Record<string, unknown>);
        return { inserted: true };
      }),
      loadEnrollmentEvents: vi.fn().mockImplementation(async (_enrId: string) => {
        return mockDb.state.events.map((e, idx) => ({
          id: (e.id as string) ?? `evt-${idx}`,
          node_id: (e.node_id as string) ?? '',
          event_type: (e.event_type as string) ?? '',
          idempotency_key: (e.idempotency_key as string) ?? '',
          payload: e.payload as Record<string, unknown>,
          created_at: (e.created_at as string) ?? new Date().toISOString(),
        }));
      }),
      isLeadInHandoff: vi.fn().mockImplementation(async () => overrides.inHandoff ?? false),
    });

    const engineTickDeps: TickDeps = {
      db: engineAdminClient,
      clock: () => new Date('2026-09-30T22:00:00.000Z'),
      enqueueJob: vi.fn().mockImplementation(async (job) => {
        sideEffects.messagesEnqueued.push(job.payload?.node_id ?? 'msg');
      }),
    };

    const advanceEnrollmentAdapter = async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      sideEffects.advanceCallCount++;
      const enr = mockDb.state.enrollments.get(enrollmentId)!;
      const row: EnrollmentRow = {
        id: enr.id,
        organization_id: advanceOrgId,
        pointer_id: 'ptr-1',
        version_id: 'v1',
        contact_id: enr.contact_id,
        conversation_id: enr.conversation_id,
        current_node_id: nextNodeId,
        status: enr.status,
        steps_taken: enr.steps_taken,
        next_eval_at: new Date().toISOString(),
        outcome: enr.outcome,
        cancel_reason: null,
        started_at: new Date().toISOString(),
        completed_at: enr.completed_at,
        updated_at: new Date().toISOString(),
        claimed_until: null,
        last_error: null,
        attempts: 0,
        max_attempts: 3,
        service_boundary: null,
      };
      await avancarEnrollmentAtivo(engineTickDeps, row);
    };

    return {
      mockDb,
      engineAdminClient,
      engineTickDeps,
      advanceEnrollmentAdapter,
      sideEffects,
    };
  }

  // =========================================================================
  // CENÁRIO A: Transition Commit -> Crash antes de advance -> Retry -> Exatamente 1x
  // =========================================================================
  it('A: transition commit -> crash antes de advance -> retry -> próximo node executa exatamente 1x', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-1',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-stage-move-1',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-message-text-1',
          type: 'message_text',
          label: 'Mensagem Confirmação',
          position: { x: 200, y: 0 },
          config: { body: 'Etapa alterada com sucesso!' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-1', target: 'node-stage-move-1', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-stage-move-1', target: 'node-message-text-1', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-durability-a';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });
    let shouldCrashOnAdvance = true;

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      if (shouldCrashOnAdvance) {
        // Simula worker morrendo EXATAMENTE no início do callback antes de avancarEnrollmentAtivo
        throw new Error('WORKER_CRASHED_BEFORE_ADVANCE');
      }
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-1',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
      inboundText: 'Concluir atendimento',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-a', status: 'sent' }),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Finalizando por aqui!',
            node_status: 'completed',
            outcome: 'qualificado',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    // 1ª Tentativa: worker processa, comita transição no banco e MORRE antes de avançar
    const firstResult = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(firstResult.status).toBe('completed');
    expect(firstResult.transitionStatus).toBe('transition_fresh');

    // Estado após crash:
    const enrAfterCrash = harness.mockDb.getEnrollment();
    expect(enrAfterCrash.current_node_id).toBe('node-stage-move-1'); // Transição comitada!
    expect(enrAfterCrash.status).toBe('active');
    expect(harness.sideEffects.stagesMoved).toHaveLength(0); // Próximo nó NÃO executou
    expect(harness.sideEffects.messagesEnqueued).toHaveLength(0);

    // 2ª Tentativa (Retry da mesma inbound):
    shouldCrashOnAdvance = false; // Worker recuperado retoma execução
    const retryResult = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);

    expect(retryResult.status).toBe('completed');
    expect(retryResult.transitionStatus).toBe('transition_already_applied');

    // Efeitos colaterais esperados: EXATAMENTE UMA VEZ cada um (nem zero nem duas vezes)
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
    expect(harness.sideEffects.messagesEnqueued).toEqual(['node-message-text-1']);
  });

  // =========================================================================
  // CENÁRIO B: advance começa -> stage_move executa -> crash antes de message_text -> recuperação continua sem repetir stage_move
  // =========================================================================
  it('B: advance começa -> stage_move executa -> crash antes de message_text -> recuperação sem duplicar stage_move', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-2',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-stage-move-2',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-message-text-2',
          type: 'message_text',
          label: 'Mensagem Confirmação',
          position: { x: 200, y: 0 },
          config: { body: 'Etapa alterada com sucesso!' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-2', target: 'node-stage-move-2', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-stage-move-2', target: 'node-message-text-2', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-durability-b';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });

    // Simula crash que ocorre logo após stage_move atualizar o banco para node-message-text-2
    let crashAfterStageMove = true;
    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      const enr = harness.mockDb.state.enrollments.get(enrollmentId)!;
      if (crashAfterStageMove && nextNodeId === 'node-stage-move-2') {
        // stage_move executa
        harness.sideEffects.stagesMoved.push(STAGE_QUALIFICADO_UUID);
        // Atualiza banco para o próximo nó
        enr.current_node_id = 'node-message-text-2';
        enr.steps_taken = (Number(enr.steps_taken) || 0) + 1;
        crashAfterStageMove = false;
        // Crash ocorre antes de processar message_text
        throw new Error('WORKER_CRASHED_AFTER_STAGE_MOVE');
      }
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-2',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
      inboundText: 'Concluir',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-b', status: 'sent' }),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Finalizando!',
            node_status: 'completed',
            outcome: 'qualificado',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    // 1ª Tentativa: stage_move executa e worker cai antes de message_text
    await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);

    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
    expect(harness.sideEffects.messagesEnqueued).toHaveLength(0);
    expect(harness.mockDb.getEnrollment().current_node_id).toBe('node-message-text-2');

    // 2ª Tentativa (Retry da mesma inbound):
    await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);

    // stage_move NÃO repetiu (permaneceu com 1 execução) e message_text executou
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
    expect(harness.sideEffects.messagesEnqueued).toEqual(['node-message-text-2']);
  });

  // =========================================================================
  // CENÁRIO C: advance termina completamente -> crash -> retry original -> nenhum efeito duplicado
  // =========================================================================
  it('C: advance termina completamente -> crash -> retry original -> zero efeitos duplicados', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-3',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-stage-move-3',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-msg-end-3',
          type: 'message_text',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { body: 'Fim' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-3', target: 'node-stage-move-3', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-stage-move-3', target: 'node-msg-end-3', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-durability-c';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
      // Fluxo completado com sucesso
      harness.mockDb.state.enrollments.get(enrollmentId)!.status = 'completed';
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-3',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
      inboundText: 'Concluir',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-c', status: 'sent' }),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Finalizando!',
            node_status: 'completed',
            outcome: 'qualificado',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    // 1ª Execução: conclui tudo
    await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
    expect(harness.mockDb.getEnrollment().status).toBe('completed');

    // 2ª Execução (Simula crash tardio e retry do webhook original):
    advanceEnrollmentSpy.mockClear();
    const retryResult = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);

    expect(retryResult.transitionStatus).toBe('transition_already_applied');
    // advanceEnrollmentFn NÃO é chamado novamente (zero duplicação)
    expect(advanceEnrollmentSpy).not.toHaveBeenCalled();
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
  });

  // =========================================================================
  // CENÁRIO D: 20 retries da mesma inbound -> uma única cadeia lógica de continuação
  // =========================================================================
  it('D: 20 retries da mesma inbound -> uma única cadeia lógica de continuação', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-4',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-stage-move-4',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-msg-end-4',
          type: 'message_text',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { body: 'Fim' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-4', target: 'node-stage-move-4', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-stage-move-4', target: 'node-msg-end-4', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-durability-d-20x';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
      harness.mockDb.state.enrollments.get(enrollmentId)!.status = 'completed';
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-4',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
      inboundText: 'Mover agora',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-d', status: 'sent' }),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Movendo!',
            node_status: 'completed',
            outcome: 'qualificado',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    // Executa 20 vezes consecutivas simulando retries agressivos de webhook
    for (let i = 1; i <= 20; i++) {
      const res = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
      if (i === 1) {
        expect(res.transitionStatus).toBe('transition_fresh');
      } else {
        expect(res.transitionStatus).toBe('transition_already_applied');
      }
    }

    // O side effect foi executado EXATAMENTE UMA VEZ
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
  });

  // =========================================================================
  // CENÁRIO E: deterministic_completed -> mesma garantia durável
  // =========================================================================
  it('E: deterministic_completed -> mesma garantia durável pós-crash', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-det',
          type: 'ai_node',
          label: 'Atendimento IA Determinístico',
          position: { x: 0, y: 0 },
          config: {
            mode: 'custom_prompt',
            custom_prompt: 'Atenda',
            deterministic_conditions: {
              min_images: 1,
            },
          },
        },
        {
          id: 'node-stage-det',
          type: 'stage_move',
          label: 'Mover Etapa',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-msg-end-det',
          type: 'message_text',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { body: 'Fim' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-det', target: 'node-stage-det', priority: 1, condition: { type: 'branch', branch_id: 'completed' } },
        { id: 'e2', source: 'node-stage-det', target: 'node-msg-end-det', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-det-crash';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });
    harness.mockDb.getEnrollment().ai_node_session.media_summary = {
      images_count: 1,
      audios_count: 0,
      documents_count: 0,
      last_media_ids: ['img-1'],
    };

    let crashBeforeAdvance = true;
    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      if (crashBeforeAdvance) {
        crashBeforeAdvance = false;
        throw new Error('CRASH_DETERMINISTIC');
      }
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
      harness.mockDb.state.enrollments.get(enrollmentId)!.status = 'completed';
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-det',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
    };

    const runModelCallSpy = vi.fn();
    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      runModelCallFn: runModelCallSpy,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    };

    // 1ª Execução com crash
    const res1 = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(res1.status).toBe('deterministic_completed');
    expect(res1.transitionStatus).toBe('transition_fresh');
    expect(harness.sideEffects.stagesMoved).toHaveLength(0);

    // 2ª Execução com retry
    const res2 = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(res2.transitionStatus).toBe('transition_already_applied');
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);
    expect(runModelCallSpy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CENÁRIO F: branch error -> mesma garantia durável pós-crash
  // =========================================================================
  it('F: branch error -> mesma garantia durável pós-crash', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-err',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-stage-fallback',
          type: 'stage_move',
          label: 'Etapa Fallback',
          position: { x: 100, y: 0 },
          config: { stage_id: STAGE_AUTO_UUID },
        },
        {
          id: 'node-msg-end-fallback',
          type: 'message_text',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { body: 'Fim' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-err', target: 'node-stage-fallback', priority: 1, condition: { type: 'branch', branch_id: 'error' } },
        { id: 'e2', source: 'node-stage-fallback', target: 'node-msg-end-fallback', priority: 1, condition: { type: 'always' } },
      ],
    };

    const inboundId = 'inbound-err-crash';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });
    let crashBeforeAdvance = true;

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      if (crashBeforeAdvance) {
        crashBeforeAdvance = false;
        throw new Error('CRASH_ON_ERROR_BRANCH');
      }
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
      harness.mockDb.state.enrollments.get(enrollmentId)!.status = 'completed';
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-err',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      advanceEnrollmentFn: advanceEnrollmentSpy,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockRejectedValue(new Error('LLM_PROVIDER_DOWN')),
    };

    // 1ª Execução: dispara erro e crash no avanço
    const res1 = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(res1.status).toBe('error');
    expect(res1.transitionStatus).toBe('transition_fresh');
    expect(harness.sideEffects.stagesMoved).toHaveLength(0);

    // 2ª Execução: retry recupera a continuação da branch error
    const res2 = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);
    expect(res2.transitionStatus).toBe('transition_already_applied');
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_AUTO_UUID]);
  });

  // =========================================================================
  // CENÁRIO G & 9: branch handoff: tag e stage_move continuam, message_text bloqueada
  // =========================================================================
  it('G/9: semantic handoff -> performHumanHandoff executado, tag e stage aplicados, message_text pausado', async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: 'node-ai-handoff',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 0, y: 0 },
          config: { mode: 'custom_prompt', custom_prompt: 'Atenda' },
        },
        {
          id: 'node-tag-precisa-humano',
          type: 'tag',
          label: 'Tag Precisa Humano',
          position: { x: 100, y: 0 },
          config: { action: 'add', tags: ['precisa_humano'] },
        },
        {
          id: 'node-stage-atendimento-humano',
          type: 'stage_move',
          label: 'Etapa Atendimento Humano',
          position: { x: 200, y: 0 },
          config: { stage_id: STAGE_QUALIFICADO_UUID },
        },
        {
          id: 'node-message-outbound-cliente',
          type: 'message_text',
          label: 'Mensagem Robô para Cliente',
          position: { x: 300, y: 0 },
          config: { body: 'Você ainda está aí?' },
        },
      ],
      edges: [
        { id: 'e1', source: 'node-ai-handoff', target: 'node-tag-precisa-humano', priority: 1, condition: { type: 'branch', branch_id: 'handoff' } },
        { id: 'e2', source: 'node-tag-precisa-humano', target: 'node-stage-atendimento-humano', priority: 1, condition: { type: 'always' } },
        { id: 'e3', source: 'node-stage-atendimento-humano', target: 'node-message-outbound-cliente', priority: 1, condition: { type: 'always' } },
      ],
    };

    let humanHandoffTriggered = false;
    const inboundId = 'inbound-handoff-durability';
    const harness = createDurabilityHarness(graph, { inboundMessageId: inboundId });

    // Quando performHumanHandoff for chamado, ativa a flag de atendimento humano
    harness.engineAdminClient.isLeadInHandoff = vi.fn().mockImplementation(async () => humanHandoffTriggered);

    const performHumanHandoffSpy = vi.fn(async () => {
      humanHandoffTriggered = true;
    });

    const advanceEnrollmentSpy = vi.fn(async (enrollmentId: string, advanceOrgId: string, nextNodeId: string) => {
      await harness.advanceEnrollmentAdapter(enrollmentId, advanceOrgId, nextNodeId);
    });

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: orgId,
      enrollmentId: enrId,
      nodeId: 'node-ai-handoff',
      inboundMessageId: inboundId,
      conversationId: convId,
      contactId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      session: harness.mockDb.getEnrollment().ai_node_session,
      inboundText: 'Quero falar com uma pessoa',
    };

    const deps: ExecuteAiNodeLifecycleDeps = {
      performHumanHandoffFn: performHumanHandoffSpy,
      advanceEnrollmentFn: advanceEnrollmentSpy,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-h', status: 'sent' }),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      runModelCallFn: vi.fn().mockResolvedValue({
        result: {
          text: JSON.stringify({
            reply: 'Transferindo para a nossa equipe!',
            node_status: 'handoff',
            outcome: 'pedido_de_humano',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const result = await executeAiNodeLifecycle(harness.mockDb as unknown as DbPoolLike, input, deps);

    // 1. Status do lifecycle é handoff e chamou performHumanHandoff
    expect(result.status).toBe('handoff');
    expect(performHumanHandoffSpy).toHaveBeenCalledTimes(1);

    // 2. Ações internas silenciosas EXECUTARAM normalmente:
    expect(harness.sideEffects.tagsApplied).toEqual(['precisa_humano']);
    expect(harness.sideEffects.stagesMoved).toEqual([STAGE_QUALIFICADO_UUID]);

    // 3. Nó de mensagem que fala com o cliente NÃO foi enviado/enfileirado:
    expect(harness.sideEffects.messagesEnqueued).toHaveLength(0);

    // 4. Fluxo foi pausado coerentemente em paused_handoff
    const finalEnr = harness.mockDb.getEnrollment();
    expect(finalEnr.status).toBe('paused_handoff');

    // 5. Evento outbound_paused_human_takeover foi registrado
    const pausedEvent = harness.mockDb.state.events.find((e) => e.event_type === 'outbound_paused_human_takeover');
    expect(pausedEvent).toBeDefined();
  });
});


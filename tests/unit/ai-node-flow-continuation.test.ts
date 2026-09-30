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
import type { EnrollmentRow } from '@/lib/followup/node-handlers';

interface MockDbState {
  enrollments: Map<string, any>;
  events: Array<Record<string, unknown>>;
  sendLedger: Map<string, Record<string, unknown>>;
  contacts: Map<string, any>;
  conversations: Map<string, any>;
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

      // UPDATE followup_enrollments
      if (cleanSql.includes('UPDATE FOLLOWUP_ENROLLMENTS')) {
        const enr = state.enrollments.get(initial.enrollmentId);
        if (enr) {
          if (cleanSql.includes('SET CURRENT_NODE_ID = $1')) {
            enr.current_node_id = params[0] as string;
            enr.steps_taken = (Number(enr.steps_taken) || 0) + 1;
            enr.ai_node_session = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
            enr.updated_at = params[2] as string;
          } else if (cleanSql.includes("SET STATUS = 'COMPLETED'")) {
            enr.status = 'completed';
            enr.outcome = params[0] as string;
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
      const enr = mockDb.state.enrollments.get(enrollmentId);
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
      const enr = mockDb.state.enrollments.get(enrollmentId);
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
      const enr = mockDb.state.enrollments.get(enrollmentId);
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
      const enr = mockDb.state.enrollments.get(enrollmentId);
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

    // Simula crash do worker: o job é re-tentado com a MESMA mensagem inbound
    advanceEnrollmentSpy.mockClear();

    // 2ª Execução (Retry da mensagem):
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

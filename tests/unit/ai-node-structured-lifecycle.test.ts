import { describe, it, expect, vi } from 'vitest';
import {
  executeAiNodeLifecycle,
  type ExecuteAiNodeLifecycleInput,
} from '@/lib/followup/ai-node-lifecycle';
import {
  acquireAiNodeInboundTurn,
  completeAiNodeInboundTurn,
  getAiNodeGeneratedReply,
  type DbPoolLike,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import type { FlowGraph, AiNodeConfig } from '@/lib/followup/graph-schema';
import { decidirRajada } from '@/lib/agent-engine/edge/crm/debounce';

export interface MockEnrollment {
  id: string;
  organization_id: string;
  current_node_id: string;
  contact_id: string;
  conversation_id: string;
  status: string;
  steps_taken: number;
  outcome: string | null;
  completed_at: string | null;
  ai_node_session: AiNodeSession;
  graph: FlowGraph;
  updated_at?: string;
}

export interface MockContact {
  id: string;
  organization_id: string;
  force_human: boolean;
  name: string;
  tags: string[];
}

// Interface do banco simulado para testes
interface MockDbState {
  enrollments: Map<string, MockEnrollment>;
  events: Array<Record<string, unknown>>;
  sendLedger: Map<string, Record<string, unknown>>;
  contacts: Map<string, MockContact>;
  conversations: Map<string, Record<string, unknown>>;
}

function createLifecycleMockDb(initial: {
  enrollmentId: string;
  organizationId: string;
  nodeId: string;
  contactId: string;
  conversationId: string;
  graph: FlowGraph;
  nodeConfig: AiNodeConfig;
  session: Partial<AiNodeSession> & { status: AiNodeSession['status'] };
}) {
  const fullSession: AiNodeSession = {
    node_id: initial.nodeId,
    mode: 'existing_agent',
    turn_count: 0,
    started_at: new Date().toISOString(),
    media_summary: {
      images_count: 0,
      audios_count: 0,
      documents_count: 0,
      last_media_ids: [],
    },
    active_turn: null,
    extracted_data: {},
    ...initial.session,
    status: initial.session.status,
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
    name: 'Cliente Teste',
    tags: [],
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

      // SELECT enrollment com join em flow_versions ou direto
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

      // Suporte ao send_ledger
      if (cleanSql.includes('INSERT INTO SEND_LEDGER')) {
        const orgId = params[0];
        const contactId = params[1];
        const jobId = params[2];
        const seq = params[3];
        const bodyHash = params[4];
        const ledgerKey = `${orgId}:${jobId}:${seq}`;
        const existing = state.sendLedger.get(ledgerKey);
        if (existing) {
          const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
          throw err;
        }
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
        const status = params[2];
        const crmId = params[3];
        const orgId = params[0];
        const id = params[1];
        for (const row of state.sendLedger.values()) {
          if (row.organization_id === orgId && row.id === id) {
            row.status = status;
            row.crm_message_id = crmId ?? row.crm_message_id;
          }
        }
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
            enr.ai_node_session = typeof params[1] === 'string' ? JSON.parse(params[1]) : (params[1] as AiNodeSession);
            enr.updated_at = params[2] as string;
          } else if (cleanSql.includes("SET STATUS = 'COMPLETED'")) {
            enr.status = 'completed';
            enr.outcome = params[0] as string;
            enr.completed_at = params[1] as string;
            enr.ai_node_session = typeof params[2] === 'string' ? JSON.parse(params[2]) : (params[2] as AiNodeSession);
          } else if (cleanSql.includes("SET STATUS = 'PAUSED_HANDOFF'")) {
            enr.status = 'paused_handoff';
            enr.outcome = 'handoff';
            if (cleanSql.includes('AI_NODE_SESSION = $1')) {
              enr.ai_node_session = typeof params[0] === 'string' ? JSON.parse(params[0]) : (params[0] as AiNodeSession);
              enr.updated_at = params[1] as string;
            } else {
              enr.updated_at = params[0] as string;
            }
          } else if (cleanSql.includes('SET AI_NODE_SESSION = $1')) {
            enr.ai_node_session = typeof params[0] === 'string' ? JSON.parse(params[0]) : (params[0] as AiNodeSession);
            enr.updated_at = params[1] as string;
          }
        }
        return { rows: [enr] };
      }

      // SELECT lead info
      if (cleanSql.includes('FROM CRM_LEADS')) {
        return { rows: [] };
      }

      return { rows: [] };
    }),
  };

  return {
    mockDb: mockDb as unknown as DbPoolLike,
    state,
    getEnrollment: () => state.enrollments.get(initial.enrollmentId)!,
  };
}

describe('Fase 4: Ciclo de Vida do Node IA (Testes A a P)', () => {
  const baseGraph: FlowGraph = {
    nodes: [
      {
        id: 'node-ai-1',
        type: 'ai_node',
        label: 'Atendimento IA',
        position: { x: 0, y: 0 },
        config: {
          mode: 'custom_prompt',
          custom_prompt: 'Ajude o cliente a agendar',
        },
      },
      {
        id: 'node-next-msg',
        type: 'message_text',
        label: 'Próxima Mensagem',
        position: { x: 100, y: 100 },
        config: { body: 'Obrigado por agendar conosco!' },
      },
      {
        id: 'node-error-fallback',
        type: 'message_text',
        label: 'Erro Fallback',
        position: { x: 100, y: 200 },
        config: { body: 'Tivemos um problema técnico.' },
      },
      {
        id: 'node-human-desk',
        type: 'message_text',
        label: 'Fila Humana',
        position: { x: 100, y: 300 },
        config: { body: 'Um humano irá lhe atender.' },
      },
    ],
    edges: [
      {
        id: 'edge-completed',
        source: 'node-ai-1',
        target: 'node-next-msg',
        priority: 1,
        condition: { type: 'branch', branch_id: 'completed' },
      },
      {
        id: 'edge-handoff',
        source: 'node-ai-1',
        target: 'node-human-desk',
        priority: 2,
        condition: { type: 'branch', branch_id: 'handoff' },
      },
      {
        id: 'edge-error',
        source: 'node-ai-1',
        target: 'node-error-fallback',
        priority: 3,
        condition: { type: 'branch', branch_id: 'error' },
      },
    ],
  };

  const initialSession: AiNodeSession = {
    node_id: 'node-ai-1',
    mode: 'existing_agent',
    status: 'running',
    started_at: '2026-09-30T10:00:00.000Z',
    turn_count: 1,
    media_summary: {
      images_count: 0,
      audios_count: 0,
      documents_count: 0,
      last_media_ids: [],
    },
    active_turn: {
      inbound_message_id: 'msg-1',
      worker_id: 'worker-test-1',
      claimed_at: '2026-09-30T10:00:00.000Z',
      lease_until: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      lease_generation: 1,
    },
    extracted_data: {},
  };

  const baseInput: ExecuteAiNodeLifecycleInput = {
    organizationId: 'org-test',
    enrollmentId: 'enr-test-1',
    nodeId: 'node-ai-1',
    inboundMessageId: 'msg-1',
    conversationId: 'conv-test-1',
    contactId: 'contact-test-1',
    workerId: 'worker-test-1',
    leaseGeneration: 1,
    inboundText: 'Olá, gostaria de saber os horários',
    graph: baseGraph,
    session: initialSession,
  };

  // =========================================================================
  // TESTE A: Structured Output continue -> envia reply -> mantém mesmo node
  // =========================================================================
  it('A: Structured Output continue -> envia reply -> mantém mesmo node', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-1', status: 'sent' });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Temos horários disponíveis amanhã às 14h e 16h. Qual prefere?',
          node_status: 'continue',
          outcome: null,
          extracted_data: { servico_interesse: 'consulta' },
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('continue');
    expect(result.reply).toBe('Temos horários disponíveis amanhã às 14h e 16h. Qual prefere?');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);

    // Mantém o mesmo nó
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-ai-1');
    expect(enr.ai_node_session.status).toBe('running');
    // Turno concluído -> active_turn liberado
    expect(enr.ai_node_session.active_turn).toBeNull();
  });

  // =========================================================================
  // TESTE B: Structured Output completed -> envia reply -> avança exatamente uma vez
  // =========================================================================
  it('B: Structured Output completed -> envia reply -> avança exatamente uma vez', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-2', status: 'sent' });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Perfeito! Seu agendamento para amanhã às 14h está confirmado.',
          node_status: 'completed',
          outcome: 'agendado_com_sucesso',
          extracted_data: { horario: '14:00', data: 'amanha' },
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('completed');
    expect(result.nextNodeId).toBe('node-next-msg');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);

    // Avança para o próximo nó
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-next-msg');
    expect(enr.steps_taken).toBe(1);
    expect(enr.ai_node_session.status).toBe('completed');
    expect(enr.ai_node_session.active_turn).toBeNull();
  });

  // =========================================================================
  // TESTE C: handoff -> envia reply quando aplicável -> humano assume
  // =========================================================================
  it('C: handoff -> envia reply quando aplicável -> humano assume', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-3', status: 'sent' });
    const performHumanHandoffFn = vi.fn().mockResolvedValue(undefined);

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Compreendo, vou transferir você agora mesmo para um de nossos atendentes.',
          node_status: 'handoff',
          outcome: 'cliente_pediu_humano',
          extracted_data: { motivo: 'reclamacao' },
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      performHumanHandoffFn,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('handoff');
    expect(result.reply).toContain('transferir você agora mesmo');
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);
    expect(performHumanHandoffFn).toHaveBeenCalledTimes(1);

    // Seguiu aresta de handoff
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-human-desk');
    expect(enr.ai_node_session.status).toBe('handoff');
  });

  // =========================================================================
  // TESTE D: Structured Output inválido após retries -> zero outbound -> branch error
  // =========================================================================
  it('D: Structured Output inválido após retries -> zero outbound -> branch error', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn();
    // Modelo retorna texto livre sem JSON
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: 'Olá, sou a IA e estou respondendo sem obedecer o formato JSON estruturado.',
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Zero outbound! Nenhuma mensagem de texto livre vazou para o cliente!
    expect(sendOutboundHandler).not.toHaveBeenCalled();
    // Falha vira erro de runtime e segue para a branch error configurada
    expect(result.status).toBe('error');
    expect(result.nextNodeId).toBe('node-error-fallback');

    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-error-fallback');
  });

  // =========================================================================
  // TESTE E: crash depois da LLM -> structured cache recuperado -> zero nova LLM
  // =========================================================================
  it('E: crash depois da LLM -> structured cache recuperado -> zero nova LLM', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    // Simula Structured Output já persistido no cache antes do worker crashar
    const cachedReplyJson = {
      reply: 'Resposta salva no cache antes do crash',
      node_status: 'completed' as const,
      outcome: 'cache_recovered',
      extracted_data: { etapa: 'final' },
    };

    mockDb.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'org-test',
        'enr-test-1',
        'node-ai-1',
        'ai_node.reply_generated',
        JSON.stringify({
          inbound_message_id: 'msg-1',
          reply_text: cachedReplyJson.reply,
          reply: cachedReplyJson.reply,
          node_status: cachedReplyJson.node_status,
          outcome: cachedReplyJson.outcome,
          extracted_data: cachedReplyJson.extracted_data,
        }),
        `ai_node_reply:org-test:enr-test-1:node-ai-1:msg-1`,
        new Date().toISOString(),
      ],
    );

    const runModelCallFn = vi.fn();
    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-cached', status: 'sent' });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Zero nova chamada de LLM!
    expect(runModelCallFn).not.toHaveBeenCalled();
    expect(result.llmStatus).toBe('recovered_structured_output');
    expect(result.reply).toBe('Resposta salva no cache antes do crash');
    expect(result.status).toBe('completed');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);

    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-next-msg');
  });

  // =========================================================================
  // TESTE F: crash depois do WhatsApp accepted -> zero reenvio -> transição é retomada
  // =========================================================================
  it('F: crash depois do WhatsApp accepted -> zero reenvio -> transição é retomada', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    // 1. Structured Output já no cache
    mockDb.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'org-test',
        'enr-test-1',
        'node-ai-1',
        'ai_node.reply_generated',
        JSON.stringify({
          inbound_message_id: 'msg-1',
          reply: 'Mensagem já aceita pelo WhatsApp',
          node_status: 'completed',
          outcome: 'enviado_ok',
          extracted_data: {},
        }),
        `ai_node_reply:org-test:enr-test-1:node-ai-1:msg-1`,
        new Date().toISOString(),
      ],
    );

    // 2. Outbound já registrado como aceito no WhatsApp antes do crash
    mockDb.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'org-test',
        'enr-test-1',
        'node-ai-1',
        'ai_node.reply_sent',
        JSON.stringify({
          inbound_message_id: 'msg-1',
          crm_message_id: 'msg-accepted-earlier',
          sent_at: new Date().toISOString(),
        }),
        `ai_node_sent:org-test:enr-test-1:node-ai-1:msg-1`,
        new Date().toISOString(),
      ],
    );

    const runModelCallFn = vi.fn();
    const sendOutboundHandler = vi.fn();

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // ZERO nova LLM e ZERO reenvio para o WhatsApp!
    expect(runModelCallFn).not.toHaveBeenCalled();
    expect(sendOutboundHandler).not.toHaveBeenCalled();
    expect(result.outboundStatus).toBe('outbound_already_sent');

    // Mas a transição de avanço do nó é retomada e concluída com sucesso!
    expect(result.status).toBe('completed');
    expect(result.nextNodeId).toBe('node-next-msg');
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-next-msg');
    expect(enr.ai_node_session.status).toBe('completed');
  });

  // =========================================================================
  // TESTE G: mesmo retry 5 vezes -> uma mensagem enviada -> uma transição
  // =========================================================================
  it('G: mesmo retry 5 vezes -> uma mensagem enviada -> uma transição', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    let llmCalls = 0;
    const runModelCallFn = vi.fn().mockImplementation(async () => {
      llmCalls++;
      return {
        result: {
          text: JSON.stringify({
            reply: 'Resposta única da LLM',
            node_status: 'completed',
            outcome: 'unica_vez',
            extracted_data: {},
          }),
        },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    });

    let outboundSends = 0;
    const sendOutboundHandler = vi.fn().mockImplementation(async () => {
      outboundSends++;
      return { id: 'crm-msg-idem', status: 'sent' };
    });

    // Roda 5 vezes o mesmo turno
    for (let i = 0; i < 5; i++) {
      await executeAiNodeLifecycle(mockDb, baseInput, {
        runModelCallFn,
        sendOutboundHandler,
        isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
        validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      });
    }

    // Exatamente 1 chamada de LLM e 1 envio de WhatsApp
    expect(llmCalls).toBe(1);
    expect(outboundSends).toBe(1);

    // Transição aplicada exatamente uma vez
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-next-msg');
    expect(enr.steps_taken).toBe(1);
  });

  // =========================================================================
  // TESTE H: humano assume durante LLM -> zero outbound da IA
  // =========================================================================
  it('H: humano assume durante LLM -> zero outbound da IA', async () => {
    const { mockDb } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn();

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Resposta que não deve sair',
          node_status: 'continue',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    // Atendente humano assumiu a conversa antes do envio!
    const isLeadInHandoffFn = vi.fn().mockResolvedValue(true);

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('aborted_human_takeover');
    expect(sendOutboundHandler).not.toHaveBeenCalled();
    expect(result.outboundStatus).toBe('skipped');
  });

  // =========================================================================
  // TESTE I: worker perde fencing depois da LLM -> zero outbound
  // =========================================================================
  it('I: worker perde fencing depois da LLM -> zero outbound', async () => {
    const { mockDb } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn();

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Resposta tardia de worker expirado',
          node_status: 'completed',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    // Fencing falha: lease expirou ou takeover ocorreu
    const validateOwnershipFn = vi.fn().mockResolvedValue({
      is_valid: false,
      reason: 'lease_expired_takeover_occurred',
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn,
    });

    expect(result.status).toBe('stale_lease_owner');
    expect(sendOutboundHandler).not.toHaveBeenCalled();
  });

  // =========================================================================
  // TESTE J: deterministic_completed -> zero LLM -> zero mensagem inventada -> avança completed
  // =========================================================================
  it('J: deterministic_completed -> zero LLM -> zero mensagem inventada -> avança completed', async () => {
    const nodeConfigWithDeterminism: AiNodeConfig = {
      mode: 'custom_prompt',
      custom_prompt: 'Aguarde envio de foto',
      deterministic_conditions: {
        min_images: 2,
      },
    };

    const sessionWithMedia: AiNodeSession = {
      ...initialSession,
      media_summary: {
        images_count: 2, // Atende à condição!
        audios_count: 0,
        documents_count: 0,
        last_media_ids: ['img-1', 'img-2'],
      },
    };

    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: nodeConfigWithDeterminism,
      session: sessionWithMedia,
    });

    const runModelCallFn = vi.fn();
    const sendOutboundHandler = vi.fn();

    const result = await executeAiNodeLifecycle(
      mockDb,
      {
        ...baseInput,
        nodeConfig: nodeConfigWithDeterminism,
        session: sessionWithMedia,
      },
      {
        runModelCallFn,
        sendOutboundHandler,
        isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
        validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      },
    );

    expect(result.status).toBe('deterministic_completed');
    expect(result.nextNodeId).toBe('node-next-msg');
    expect(result.outboundStatus).toBe('skipped');
    // Zero LLM e Zero envio!
    expect(runModelCallFn).not.toHaveBeenCalled();
    expect(sendOutboundHandler).not.toHaveBeenCalled();

    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-next-msg');
    expect(enr.ai_node_session.status).toBe('completed');
  });

  // =========================================================================
  // TESTE K: JSON/structured output inválido -> nunca vaza JSON para cliente
  // =========================================================================
  it('K: JSON/structured output inválido -> nunca vaza JSON para cliente', async () => {
    const { mockDb } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const sendOutboundHandler = vi.fn();

    // LLM responde texto com JSON corrompido
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: '{"reply": "Quebrado sem fechar aspas, "node_status": ',
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      structuredOutputRequired: true,
    });

    expect(result.status).toBe('error');
    // NUNCA envia o JSON corrompido para o cliente!
    expect(sendOutboundHandler).not.toHaveBeenCalled();
    expect(result.reply).toBeUndefined();
  });

  // =========================================================================
  // TESTE L: extracted_data malicioso/arbitrário -> não altera CRM
  // =========================================================================
  it('L: extracted_data malicioso/arbitrário -> não altera CRM', async () => {
    const { mockDb, state, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Dados recebidos.',
          node_status: 'continue',
          outcome: null,
          extracted_data: {
            stage_id: 'malicious-stage-injection',
            tags: ['admin', 'owner'],
            contact_name: 'Novo Nome Hackeado',
            balance_cents: 99999999,
          },
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-4', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // O contato no CRM permaneceu intacto!
    const contact = state.contacts.get('contact-test-1');
    expect(contact?.name).toBe('Cliente Teste');
    expect(contact?.tags).toEqual([]);

    // O extracted_data foi mantido estritamente na sessão interna do Node IA
    const enr = getEnrollment();
    expect(enr.ai_node_session.extracted_data?.stage_id).toBe('malicious-stage-injection');
    expect(enr.ai_node_session.extracted_data?.contact_name).toBe('Novo Nome Hackeado');
  });

  // =========================================================================
  // TESTE M: 3 mensagens distintas em rajada -> não existem 3 LLMs paralelas -> nenhuma mensagem perdida
  // =========================================================================
  it('M: 3 mensagens distintas em rajada -> não existem 3 LLMs paralelas -> nenhuma mensagem perdida', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: {
        status: 'running',
        started_at: '2026-09-30T10:00:00.000Z',
        turn_count: 0,
        active_turn: null,
      },
    });

    // 1. Mensagem A chega e adquire claim
    const resA = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-A',
      workerId: 'worker-A',
    });
    expect(resA.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.active_turn?.inbound_message_id).toBe('msg-A');

    // 2. Mensagem B chega em rajada rápida enquanto A ainda está processando
    const resB = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-B',
      workerId: 'worker-B',
    });
    // B é protegida contra sobreposição: retorna in_progress e mantém A como dona
    expect(resB.status).toBe('in_progress');
    expect((resB as { active_inbound_message_id?: string }).active_inbound_message_id).toBe('msg-A');
    expect(getEnrollment().ai_node_session.active_turn?.inbound_message_id).toBe('msg-A');

    // 3. Mensagem C chega em rajada rápida
    const resC = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-C',
      workerId: 'worker-C',
    });
    expect(resC.status).toBe('in_progress');
    expect((resC as { active_inbound_message_id?: string }).active_inbound_message_id).toBe('msg-A');

    // Nenhuma LLM paralela foi aberta para B e C!
    expect(getEnrollment().ai_node_session.turn_count).toBe(1);

    // 4. Mensagem A conclui seu turno
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-A',
      workerId: 'worker-A',
      leaseGeneration: 1,
    });
    expect(getEnrollment().ai_node_session.active_turn).toBeNull();

    // 5. Agora Mensagem B pode ser processada sequencialmente sem perda!
    const resBSequencial = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-B',
      workerId: 'worker-B',
    });
    expect(resBSequencial.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.active_turn?.inbound_message_id).toBe('msg-B');
    expect(getEnrollment().ai_node_session.turn_count).toBe(2);
  });

  // =========================================================================
  // TESTE N: continue encerra TURNO mas mantém NODE ativo
  // =========================================================================
  it('N: continue encerra TURNO mas mantém NODE ativo', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Qual seu nome?',
          node_status: 'continue',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-5', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('continue');

    const enr = getEnrollment();
    // Turno encerrado: active_turn limpo
    expect(enr.ai_node_session.active_turn).toBeNull();
    // Mas o NODE continua o mesmo e running
    expect(enr.current_node_id).toBe('node-ai-1');
    expect(enr.ai_node_session.status).toBe('running');
  });

  // =========================================================================
  // TESTE O: completed encerra TURNO e NODE
  // =========================================================================
  it('O: completed encerra TURNO e NODE', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Tudo pronto!',
          node_status: 'completed',
          outcome: 'finalizado',
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-6', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result.status).toBe('completed');
    expect(result.nextNodeId).toBe('node-next-msg');

    const enr = getEnrollment();
    // Turno encerrado: active_turn limpo
    expect(enr.ai_node_session.active_turn).toBeNull();
    // Node encerrado: sessão completed e nó transitou para o próximo
    expect(enr.ai_node_session.status).toBe('completed');
    expect(enr.current_node_id).toBe('node-next-msg');
  });

  // =========================================================================
  // TESTE P: reply cache contém status/outcome/extracted_data completos
  // =========================================================================
  it('P: reply cache contém status/outcome/extracted_data completos', async () => {
    const { mockDb } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Dados guardados perfeitamente',
          node_status: 'completed',
          outcome: 'sucesso_total',
          extracted_data: { lead_score: 95, preferencial: true },
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-7', status: 'sent' }),
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Consulta direta ao reply cache
    const cached = await getAiNodeGeneratedReply(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-1',
    });

    expect(cached).not.toBeNull();
    expect(cached?.reply).toBe('Dados guardados perfeitamente');
    expect(cached?.node_status).toBe('completed');
    expect(cached?.outcome).toBe('sucesso_total');
    expect(cached?.extracted_data).toEqual({ lead_score: 95, preferencial: true });
    expect(cached?.provider).toBe('anthropic');
    expect(cached?.model).toBe('claude-3-5-sonnet');
  });

  // =========================================================================
  // AUDITORIA B: completed sem branch completed -> nunca usa aresta arbitrária
  // =========================================================================
  it('Auditoria B: completed sem branch completed -> nunca usa aresta arbitrária -> segue branch error', async () => {
    // Grafo onde o nó de IA NÃO possui branch completed, possui apenas uma aresta genérica "always" para node-arbitrario e branch error
    const graphWithoutCompletedBranch: FlowGraph = {
      ...baseGraph,
      edges: [
        {
          id: 'edge-always-fallback',
          source: 'node-ai-1',
          target: 'node-arbitrario',
          priority: 1,
          condition: { type: 'always' },
        },
        {
          id: 'edge-error',
          source: 'node-ai-1',
          target: 'node-error-fallback',
          priority: 2,
          condition: { type: 'branch', branch_id: 'error' },
        },
      ],
    };

    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: graphWithoutCompletedBranch,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Objetivo concluído com sucesso!',
          node_status: 'completed',
          outcome: 'meta_atingida',
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const result = await executeAiNodeLifecycle(
      mockDb,
      { ...baseInput, graph: graphWithoutCompletedBranch },
      {
        runModelCallFn,
        sendOutboundHandler: vi.fn().mockResolvedValue({ id: 'crm-msg-b', status: 'sent' }),
        isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
        validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      },
    );

    // NUNCA seguiu 'node-arbitrario'! Foi para a branch 'error'!
    expect(result.status).toBe('error');
    expect(result.nextNodeId).toBe('node-error-fallback');

    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-error-fallback');
    expect(enr.current_node_id).not.toBe('node-arbitrario');
  });

  // =========================================================================
  // AUDITORIA C: 3 inbound IDs diferentes enquanto primeiro está ativo
  // =========================================================================
  it('Auditoria C: 3 inbound IDs diferentes enquanto primeiro está ativo -> todos continuam processáveis -> nenhum job descartado', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: {
        status: 'running',
        started_at: '2026-09-30T10:00:00.000Z',
        turn_count: 0,
        active_turn: null,
      },
    });

    // 1. Mensagem A chega e adquire claim
    const resA = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-A',
      workerId: 'worker-A',
    });
    expect(resA.status).toBe('acquired');

    // 2. Mensagens B e C chegam em rajada enquanto A está ativa
    const resB = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-B',
      workerId: 'worker-B',
    });
    expect(resB.status).toBe('in_progress');
    expect((resB as { active_inbound_message_id?: string }).active_inbound_message_id).toBe('msg-A');

    const resC = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-C',
      workerId: 'worker-C',
    });
    expect(resC.status).toBe('in_progress');

    // 3. Mensagem A conclui com sucesso
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-A',
      workerId: 'worker-A',
      leaseGeneration: 1,
    });
    expect(getEnrollment().ai_node_session.active_turn).toBeNull();

    // 4. Mensagem B é retomada da fila de reschedule e adquire o turno
    const resBRetomada = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-B',
      workerId: 'worker-B',
    });
    expect(resBRetomada.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.active_turn?.inbound_message_id).toBe('msg-B');

    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-B',
      workerId: 'worker-B',
      leaseGeneration: 1,
    });

    // 5. Mensagem C é retomada e adquire o turno
    const resCRetomada = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-C',
      workerId: 'worker-C',
    });
    expect(resCRetomada.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.active_turn?.inbound_message_id).toBe('msg-C');

    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-C',
      workerId: 'worker-C',
      leaseGeneration: 1,
    });

    // Todas as 3 mensagens foram processadas sequencialmente sem perda de dados
    expect(getEnrollment().ai_node_session.turn_count).toBe(3);
  });

  // =========================================================================
  // AUDITORIA D: rajada fragmentada usa debounce/coalescing existente
  // =========================================================================
  it('Auditoria D: rajada fragmentada usa debounce/coalescing existente para evitar múltiplas respostas', async () => {
    interface FakeJob {
      id: string;
      org: string;
      contact: string;
      status: string;
      runAfter: number;
    }
    const rowsJobQueue: FakeJob[] = [];
    const poolMock = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('select id from job_queue')) {
          const orgId = params[0] as string;
          const contactId = params[1] as string;
          const match = rowsJobQueue.find(
            (j) => j.org === orgId && j.contact === contactId && j.status === 'pending',
          );
          return { rows: match ? [{ id: match.id }] : [] };
        }
        return { rows: [] };
      }),
    };

    const alvo = { organizationId: 'org-1', contactId: 'lead-1' };
    const debounceMs = 3000;
    const t0 = 1000000;

    // Mensagem 1: "Oi"
    const d1 = await decidirRajada(poolMock as unknown as Parameters<typeof decidirRajada>[0], alvo, debounceMs, t0);
    expect(d1.tipo).toBe('enfileirar');
    if (d1.tipo === 'enfileirar') {
      expect(d1.runAfter?.getTime()).toBe(t0 + debounceMs);

      // Registra o job 1 pendente com run_after
      rowsJobQueue.push({
        id: 'job-1',
        org: alvo.organizationId,
        contact: alvo.contactId,
        status: 'pending',
        runAfter: d1.runAfter!.getTime(),
      });
    }

    // Mensagem 2: "queria saber" (1 segundo depois)
    const d2 = await decidirRajada(poolMock as unknown as Parameters<typeof decidirRajada>[0], alvo, debounceMs, t0 + 1000);
    expect(d2.tipo).toBe('coalescido');
    if (d2.tipo === 'coalescido') {
      expect(d2.jobId).toBe('job-1');
    }

    // Mensagem 3: "quanto custa" (2 segundos depois)
    const d3 = await decidirRajada(poolMock as unknown as Parameters<typeof decidirRajada>[0], alvo, debounceMs, t0 + 2000);
    expect(d3.tipo).toBe('coalescido');
    if (d3.tipo === 'coalescido') {
      expect(d3.jobId).toBe('job-1');
    }

    // Apenas job-1 é executado, agrupando todas as mensagens
  });

  // =========================================================================
  // AUDITORIA E: turn_count +1 por mensagem lógica e nunca +2
  // =========================================================================
  it('Auditoria E: turn_count +1 por mensagem lógica e nunca +2 (regra estrita)', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: {
        status: 'running',
        started_at: '2026-09-30T10:00:00.000Z',
        turn_count: 0,
        active_turn: null,
      },
    });

    expect(getEnrollment().ai_node_session.turn_count).toBe(0);

    // msg-1: acquire
    const r1 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-1',
      workerId: 'worker-1',
    });
    expect(r1.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.turn_count).toBe(1);

    // msg-1: complete (continue) -> turn_count permanece 1 (não faz +1 no complete)
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-1',
      workerId: 'worker-1',
      leaseGeneration: 1,
    });
    expect(getEnrollment().ai_node_session.turn_count).toBe(1);

    // msg-2: acquire
    const r2 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-2',
      workerId: 'worker-1',
    });
    expect(r2.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.turn_count).toBe(2);

    // msg-2: complete (continue) -> turn_count permanece 2
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-2',
      workerId: 'worker-1',
      leaseGeneration: 1,
    });
    expect(getEnrollment().ai_node_session.turn_count).toBe(2);

    // msg-3: acquire
    const r3 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-3',
      workerId: 'worker-1',
    });
    expect(r3.status).toBe('acquired');
    expect(getEnrollment().ai_node_session.turn_count).toBe(3);

    // msg-3: complete (completed) -> turn_count permanece 3
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-3',
      workerId: 'worker-1',
      leaseGeneration: 1,
    });
    expect(getEnrollment().ai_node_session.turn_count).toBe(3);

    // Retry de mensagem já concluída (ex: msg-3) -> status 'completed', turn_count permanece 3
    const retryRes = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test',
      enrollmentId: 'enr-test-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-3',
      workerId: 'worker-1',
    });
    expect(retryRes.status).toBe('completed');
    expect(getEnrollment().ai_node_session.turn_count).toBe(3);
  });

  // =========================================================================
  // AUDITORIA F: humano assume após outbound accepted mas antes de transition
  // =========================================================================
  it('Auditoria F: humano assume após outbound accepted mas antes de transition -> automação não ignora takeover', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Encaminhando sua solicitação',
          node_status: 'completed',
          outcome: 'finalizado',
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    let checkCount = 0;
    // Primeira checagem (pré-outbound) = false; Segunda checagem (pós-outbound/pré-transição) = true!
    const isLeadInHandoffFn = vi.fn().mockImplementation(async () => {
      checkCount++;
      return checkCount > 1;
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-post', status: 'sent' });

    const result = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Outbound foi enviado, mas a transição foi interrompida pelo takeover!
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('aborted_human_takeover');
    expect(result.reason).toBe('human_takeover_before_transition');

    const enr = getEnrollment();
    // NÃO avançou para node-next-msg! Permaneceu no nó do IA pausado
    expect(enr.current_node_id).toBe('node-ai-1');
    expect(enr.status).toBe('paused_handoff');
  });

  // =========================================================================
  // AUDITORIA G: transition retry -> exatamente uma transição
  // =========================================================================
  it('Auditoria G: transition retry -> exatamente uma transição', async () => {
    const { mockDb, getEnrollment } = createLifecycleMockDb({
      enrollmentId: 'enr-test-1',
      organizationId: 'org-test',
      nodeId: 'node-ai-1',
      contactId: 'contact-test-1',
      conversationId: 'conv-test-1',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    });

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Avançando fluxo',
          node_status: 'completed',
          outcome: 'transicionado',
          extracted_data: {},
        }),
      },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      usage: { inputTokens: 40, outputTokens: 10 },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-g', status: 'sent' });

    // 1ª execução
    const r1 = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(r1.status).toBe('completed');
    expect(r1.transitionStatus).toBe('transition_fresh');
    expect(getEnrollment().steps_taken).toBe(1);
    expect(getEnrollment().current_node_id).toBe('node-next-msg');

    // 2ª execução (retry da mesma mensagem)
    const r2 = await executeAiNodeLifecycle(mockDb, baseInput, {
      runModelCallFn,
      sendOutboundHandler,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Detecta replay seguro e transition_already_applied
    expect(r2.transitionStatus).toBe('transition_already_applied');
    // steps_taken NÃO foi incrementado novamente
    expect(getEnrollment().steps_taken).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  executeAiNodeLifecycle,
  type ExecuteAiNodeLifecycleInput,
} from '@/lib/followup/ai-node-lifecycle';
import { acquireAiNodeInboundTurn } from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import type { FlowGraph, AiNodeConfig } from '@/lib/followup/graph-schema';
import { createMockDb } from './ai-node-idempotency.test';
import type { SendLedgerStatus } from '@/lib/agent-engine/edge/crm/send-ledger';

const baseGraph: FlowGraph = {
  nodes: [
    {
      id: 'node-ai-1',
      type: 'ai_node',
      label: 'Node IA',
      position: { x: 0, y: 0 },
      config: {
        mode: 'custom_prompt',
        custom_prompt: 'Você é um assistente prestativo. Responda educadamente.',
        max_turns: 5,
        timeout_seconds: 300,
      } as AiNodeConfig,
    },
    {
      id: 'node-error-1',
      type: 'message_text',
      label: 'Erro',
      position: { x: 100, y: 200 },
      config: { body: 'E2E ERROR' },
    },
  ],
  edges: [
    {
      id: 'edge-err',
      source: 'node-ai-1',
      target: 'node-error-1',
      condition: { type: 'branch', branch_id: 'error' },
      priority: 1,
    },
  ],
};

function createFkAwareLedgerStore(validJobIds: Set<string>) {
  type LedgerRow = {
    id: string;
    organization_id: string;
    contact_id: string | null;
    job_id: string;
    seq: number;
    body_hash: string;
    status: SendLedgerStatus;
    crm_message_id: string | null;
    last_error: string | null;
  };

  const rows = new Map<string, LedgerRow>();

  return {
    rows,
    store: {
      async create(
        input: { tenantId: string; leadId: string | null; jobId: string; seq: number; body: string },
        hash: string,
      ): Promise<string> {
        // Valida Foreign Key contra job_queue (mesmo comportamento do Postgres)
        if (!validJobIds.has(input.jobId)) {
          const fkErr = new Error(
            `insert or update on table "send_ledger" violates foreign key constraint "send_ledger_job_id_fkey"`,
          );
          (fkErr as unknown as { code: string }).code = '23503';
          throw fkErr;
        }

        const compositeKey = `${input.tenantId}:${input.jobId}:${input.seq}`;
        if (rows.has(compositeKey)) {
          const dupErr = new Error(
            `duplicate key value violates unique constraint "send_ledger_job_id_seq_key"`,
          );
          (dupErr as unknown as { code: string }).code = '23505';
          throw dupErr;
        }

        const id = `ledger-${rows.size + 1}-${input.jobId}`;
        const row: LedgerRow = {
          id,
          organization_id: input.tenantId,
          contact_id: input.leadId,
          job_id: input.jobId,
          seq: input.seq,
          body_hash: hash,
          status: 'requested',
          crm_message_id: null,
          last_error: null,
        };
        rows.set(compositeKey, row);
        return id;
      },

      async find(input: { tenantId: string; jobId: string; seq: number }): Promise<{
        id: string;
        status: SendLedgerStatus;
        crm_message_id: string | null;
      } | null> {
        const compositeKey = `${input.tenantId}:${input.jobId}:${input.seq}`;
        const r = rows.get(compositeKey);
        if (!r) return null;
        return { id: r.id, status: r.status, crm_message_id: r.crm_message_id };
      },

      async rotate(
        input: { tenantId: string; jobId: string; seq: number },
        hash: string,
      ): Promise<string> {
        const compositeKey = `${input.tenantId}:${input.jobId}:${input.seq}`;
        const existing = rows.get(compositeKey);
        if (!existing) throw new Error('send_ledger_rotation_missing');
        const newId = `rotated-${existing.id}`;
        existing.id = newId;
        existing.status = 'requested';
        existing.body_hash = hash;
        existing.crm_message_id = null;
        existing.last_error = null;
        return newId;
      },

      async message(_org: string, _key: string) {
        return null;
      },

      async update(
        _org: string,
        key: string,
        status: SendLedgerStatus,
        id: string | null,
        error: string | null,
      ): Promise<void> {
        for (const row of rows.values()) {
          if (row.id === key) {
            row.status = status;
            if (id) row.crm_message_id = id;
            if (error) row.last_error = error;
            break;
          }
        }
      },
    },
  };
}

function createTestDb(initialEnrollment: Parameters<typeof createMockDb>[0]) {
  const base = createMockDb(initialEnrollment);
  const origQuery = base.mockDb.query.bind(base.mockDb);

  base.mockDb.query = async (sql: string, params: unknown[] = []) => {
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');
    if (normalizedSql.includes('UPDATE followup_enrollments') && normalizedSql.includes('current_node_id = $1')) {
      const enr = base.getEnrollment();
      enr.current_node_id = params[0] as string;
      if (params[1]) {
        enr.ai_node_session = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
      }
      return { rows: [] };
    }
    return origQuery(sql, params);
  };
  return base;
}

describe('Regressão send_ledger: validação de FK com job_queue e Happy Path de envio do Node IA', () => {
  const realJobId = '6aeed2d2-d6a5-4491-9255-438117b5ad79';
  const validJobIds = new Set<string>([realJobId]);

  const initialSession: AiNodeSession = {
    node_id: 'node-ai-1',
    flow_id: 'ceb22aed-b1bb-406b-ae0f-dabd725e7f57',
    mode: 'custom_prompt',
    status: 'running',
    turn_count: 0,
    started_at: '2026-10-02T16:00:00Z',
    media_summary: { images_count: 0, audios_count: 0, documents_count: 0, last_media_ids: [] },
  };

  it('1. UUID sintético não existente em job_queue causa violação de FK e direciona para branch de erro com session.status=error', async () => {
    const { mockDb, getEvents, getEnrollment } = createTestDb({
      id: 'enr-fk-fail-1',
      organization_id: 'org-test-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-test-1',
    });

    const { store } = createFkAwareLedgerStore(validJobIds);

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-fail-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-1',
      conversationId: 'conv-test-1',
      contactId: 'contact-test-1',
      // Sem passar input.jobId -> usa deterministicUuid sintético
      workerId: 'worker-1',
      leaseGeneration: 1,
      inboundText: 'Oi, tudo bem?',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    };

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Olá! Tudo bem, obrigado por perguntar. Como posso ajudar você hoje?',
          node_status: 'continue',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 498, outputTokens: 45 },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-out-1', status: 'sent' });

    const acquire = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-fail-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-1',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
    });
    expect(acquire.status).toBe('acquired');

    const result = await executeAiNodeLifecycle(mockDb, input, {
      runModelCallFn,
      sendOutboundHandler,
      ledgerStore: store,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // 1. Falha capturada e tratada com reason send_with_ledger_exception
    expect(result.status).toBe('error');
    expect(result.reason).toBe('send_with_ledger_exception');
    expect(result.nextNodeId).toBe('node-error-1');

    // 2. Não chamou outbound handler pois o ledger falhou na persistência da intenção
    expect(sendOutboundHandler).not.toHaveBeenCalled();

    // 3. Evento ai_node.error registrado
    const events = getEvents();
    const errorEvent = events.find((e) => e.event_type === 'ai_node.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.payload).toMatchObject({
      reason: 'send_with_ledger_exception',
      inbound_message_id: 'msg-inbound-1',
    });

    // 4. Auditoria de inconsistência secundária: session final salva deve ter status='error' (não 'completed')
    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-error-1');
    expect(enr.ai_node_session?.status).toBe('error');
  });

  it('2. HAPPY PATH: jobId real existente em job_queue persiste no send_ledger, despacha outbound e continua turno', async () => {
    const { mockDb, getEvents, getEnrollment } = createTestDb({
      id: 'enr-fk-success-1',
      organization_id: 'org-test-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-test-1',
    });

    const { store, rows } = createFkAwareLedgerStore(validJobIds);

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-success-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-happy',
      conversationId: 'conv-test-1',
      contactId: 'contact-test-1',
      jobId: realJobId, // Job real existente em job_queue!
      workerId: 'worker-1',
      leaseGeneration: 1,
      inboundText: 'Oi, tudo bem?',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    };

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Olá! Tudo bem, como posso ajudar?',
          node_status: 'continue',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 498, outputTokens: 45 },
    });

    const sendOutboundHandler = vi.fn().mockResolvedValue({ id: 'crm-msg-happy-1', status: 'sent' });

    const acquire = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-success-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-happy',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
    });
    expect(acquire.status).toBe('acquired');

    const result = await executeAiNodeLifecycle(mockDb, input, {
      runModelCallFn,
      sendOutboundHandler,
      ledgerStore: store,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Pipeline verificado:
    // ai_node.reply_generated -> sendWithLedger -> send_ledger persisted -> ai_node.reply_sent -> ai_node.continue
    expect(result.status).toBe('continue');
    expect(result.reply).toBe('Olá! Tudo bem, como posso ajudar?');
    expect(result.outboundStatus).toBe('outbound_fresh');
    expect(sendOutboundHandler).toHaveBeenCalledTimes(1);

    // Confirma send_ledger persistido com status accepted e crm_message_id != null
    const ledgerEntry = Array.from(rows.values())[0];
    expect(ledgerEntry).toBeDefined();
    expect(ledgerEntry?.job_id).toBe(realJobId);
    expect(ledgerEntry?.status).toBe('accepted');
    expect(ledgerEntry?.crm_message_id).toBe('crm-msg-happy-1');

    // Confirma evento ai_node.reply_sent persistido com crmMessageId
    const events = getEvents();
    const replySentEvent = events.find((e) => e.event_type === 'ai_node.reply_sent');
    expect(replySentEvent).toBeDefined();
    expect(replySentEvent?.payload?.crm_message_id).toBe('crm-msg-happy-1');

    // Confirma conclusão de turno com outbound_message_id != null
    const turnCompletedEvent = events.find((e) => e.event_type === 'ai_node.turn_completed');
    expect(turnCompletedEvent).toBeDefined();
    expect(turnCompletedEvent?.payload?.outbound_message_id).toBe('crm-msg-happy-1');

    const enr = getEnrollment();
    expect(enr.current_node_id).toBe('node-ai-1');
    expect(enr.ai_node_session?.status).toBe('running');
  });

  it('3. IDEMPOTÊNCIA E RETRY: re-execução com mesmo jobId e seq reconhece accepted e não reenvia (zero duplicação)', async () => {
    const { mockDb, getEvents: _getEvents } = createTestDb({
      id: 'enr-fk-retry-1',
      organization_id: 'org-test-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-test-1',
    });

    const { store, rows } = createFkAwareLedgerStore(validJobIds);

    const input: ExecuteAiNodeLifecycleInput = {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-retry-1',
      nodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-retry-1',
      conversationId: 'conv-test-1',
      contactId: 'contact-test-1',
      jobId: realJobId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      inboundText: 'Oi, tudo bem?',
      graph: baseGraph,
      nodeConfig: baseGraph.nodes[0]!.config as AiNodeConfig,
      session: { ...initialSession },
    };

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: {
        text: JSON.stringify({
          reply: 'Resposta original',
          node_status: 'continue',
          outcome: null,
          extracted_data: {},
        }),
      },
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const sendOutboundSpy = vi.fn().mockResolvedValue({ id: 'crm-msg-retry-id', status: 'sent' });

    const acquire1 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-test-1',
      enrollmentId: 'enr-fk-retry-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-retry-1',
      workerId: 'worker-1',
      leaseDurationMs: 60_000,
    });
    expect(acquire1.status).toBe('acquired');

    // Primeira execução (fresh)
    const result1 = await executeAiNodeLifecycle(mockDb, input, {
      runModelCallFn,
      sendOutboundHandler: sendOutboundSpy,
      ledgerStore: store,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(result1.status).toBe('continue');
    expect(result1.outboundStatus).toBe('outbound_fresh');
    expect(sendOutboundSpy).toHaveBeenCalledTimes(1);

    // Segunda execução (retry simulando crash ou re-tentativa da mensagem)
    const result2 = await executeAiNodeLifecycle(mockDb, input, {
      runModelCallFn,
      sendOutboundHandler: sendOutboundSpy,
      ledgerStore: store,
      isLeadInHandoffFn: vi.fn().mockResolvedValue(false),
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    // Zero duplicação: sendOutboundSpy NÃO pode ter sido chamado novamente
    expect(sendOutboundSpy).toHaveBeenCalledTimes(1);
    expect(result2.status).toBe('continue');
    expect(rows.size).toBe(1);
  });
});

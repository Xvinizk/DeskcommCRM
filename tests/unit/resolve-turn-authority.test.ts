import { describe, expect, it, vi } from 'vitest';
import { resolveTurnAuthority } from '@/lib/agent-engine/agent/turn-authority';
import type { TurnAgentResolution } from '@/lib/agent-engine/agent/resolve-turn-agent';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';

function fakeAgent(id: string): PublishedAgentConfig {
  return {
    agentId: id,
    versionId: `v-${id}`,
    agentName: id,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    splitMessages: false,
    splitMaxChars: 900,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
  };
}

const baseInput = {
  tenantId: 'org-tenant-1',
  leadId: 'contact-lead-1',
  jobId: 'job-1',
  conversationId: 'conv-1',
  channelSessionId: 'channel-sess-1',
  inboundMessageId: 'msg-inbound-1',
};

describe('resolveTurnAuthority', () => {
  it('A. Humano assumiu a conversa → authority = human (IA não responde)', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(true);
    const findActiveAiNodeSession = vi.fn();
    const resolveConversationTurn = vi.fn();

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(res.authority).toBe('human');
    if (res.authority === 'human') {
      expect(res.reason).toBe('lead_in_handoff');
    }
    expect(isLeadInHandoff).toHaveBeenCalledWith(expect.anything(), baseInput.tenantId, baseInput.leadId);
    expect(findActiveAiNodeSession).not.toHaveBeenCalled();
    expect(resolveConversationTurn).not.toHaveBeenCalled();
  });

  it('B. Node IA ativo + flag true → authority = ai_node', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);
    const mockSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      agent_id: 'a0000000-0000-0000-0000-000000000001',
      agent_version_id: 'b0000000-0000-0000-0000-000000000001',
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

    const findActiveAiNodeSession = vi.fn().mockResolvedValue({
      enrollment_id: 'enrollment-1',
      flow_id: 'flow-1',
      node_id: 'node-ai-1',
      session: mockSession,
    });
    const resolveConversationTurn = vi.fn();

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(res.authority).toBe('ai_node');
    if (res.authority === 'ai_node') {
      expect(res.enrollment_id).toBe('enrollment-1');
      expect(res.flow_id).toBe('flow-1');
      expect(res.node_id).toBe('node-ai-1');
      expect(res.agent_id).toBe('a0000000-0000-0000-0000-000000000001');
      expect(res.inbound_message_id).toBe('msg-inbound-1');
      expect(res.session).toEqual(mockSession);
    }
    expect(resolveConversationTurn).not.toHaveBeenCalled();
  });

  it('C. Node IA ativo + flag false → comportamento legado (ignora Node IA)', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);
    const findActiveAiNodeSession = vi.fn();
    const legacyResolution: TurnAgentResolution = {
      config: fakeAgent('agent-legado'),
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: 'no_router',
    };
    const resolveConversationTurn = vi.fn().mockResolvedValue(legacyResolution);

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: false, // Flag desligada!
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(findActiveAiNodeSession).not.toHaveBeenCalled();
    expect(resolveConversationTurn).toHaveBeenCalledTimes(1);
    expect(res.authority).toBe('session_agent');
    if (res.authority === 'session_agent') {
      expect(res.config?.agentId).toBe('agent-legado');
      expect(res.resolution.outcome).toBe('no_router');
    }
  });

  it('D. Sem Node IA + router ativo → router continua funcionando (authority = intent_router)', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);
    const findActiveAiNodeSession = vi.fn().mockResolvedValue(null);
    const routerResolution: TurnAgentResolution = {
      config: fakeAgent('agent-vendas'),
      routerId: 'router-123',
      intentName: 'comprar',
      confidence: 0.95,
      outcome: 'classified',
    };
    const resolveConversationTurn = vi.fn().mockResolvedValue(routerResolution);

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(findActiveAiNodeSession).toHaveBeenCalled();
    expect(resolveConversationTurn).toHaveBeenCalled();
    expect(res.authority).toBe('intent_router');
    if (res.authority === 'intent_router') {
      expect(res.config?.agentId).toBe('agent-vendas');
      expect(res.resolution.routerId).toBe('router-123');
      expect(res.resolution.intentName).toBe('comprar');
    }
  });

  it('E. Sem Node IA + sem router → agente padrão da sessão continua funcionando', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);
    const findActiveAiNodeSession = vi.fn().mockResolvedValue(null);
    const sessionResolution: TurnAgentResolution = {
      config: fakeAgent('agent-sessao-padrao'),
      routerId: null,
      intentName: null,
      confidence: null,
      outcome: 'no_router',
    };
    const resolveConversationTurn = vi.fn().mockResolvedValue(sessionResolution);

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(res.authority).toBe('session_agent');
    if (res.authority === 'session_agent') {
      expect(res.config?.agentId).toBe('agent-sessao-padrao');
      expect(res.resolution.outcome).toBe('no_router');
    }
  });

  it('F. Sem Node IA + router com fallback acionado → authority = fallback', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);
    const findActiveAiNodeSession = vi.fn().mockResolvedValue(null);
    const fallbackResolution: TurnAgentResolution = {
      config: fakeAgent('agent-fallback'),
      routerId: 'router-123',
      intentName: null,
      confidence: null,
      outcome: 'fallback',
    };
    const resolveConversationTurn = vi.fn().mockResolvedValue(fallbackResolution);

    const res = await resolveTurnAuthority(
      {} as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
        findActiveAiNodeSession,
        resolveConversationTurn,
      },
    );

    expect(res.authority).toBe('fallback');
    if (res.authority === 'fallback') {
      expect(res.config?.agentId).toBe('agent-fallback');
    }
  });

  it('G. Regressão Bug A: resolveTurnAuthority executa defaultFindActiveAiNodeSession contra schema real sem consultar p.flow_id inexistente', async () => {
    const isLeadInHandoff = vi.fn().mockResolvedValue(false);

    // Schema canônico de followup_flow_pointers segundo migrations 0054/baseline:
    // colunas válidas: id, organization_id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, created_at, updated_at
    // Coluna NÃO existente: flow_id (o identificador é id)
    const validPointerCols = new Set([
      'id',
      'organization_id',
      'name',
      'status',
      'active_version_id',
      'draft_graph',
      'handoff_policy',
      'trigger_config',
      'created_at',
      'updated_at',
    ]);

    const pointerId = 'flow-pointer-uuid-canonical';
    const mockSession: AiNodeSession = {
      node_id: 'node-ai-active',
      flow_id: pointerId,
      mode: 'existing_agent',
      agent_id: 'a0000000-0000-0000-0000-000000000001',
      agent_version_id: 'b0000000-0000-0000-0000-000000000001',
      status: 'running',
      turn_count: 0,
      started_at: '2026-10-02T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    // Fixture de db que valida estritamente o schema das tabelas e aliases consultados
    const dbFixture = {
      query: vi.fn(async (sql: string, _params: unknown[]) => {
        // Valida se qualquer coluna de p.<coluna> inexiste em followup_flow_pointers
        const pMatches = Array.from(sql.matchAll(/\bp\.([a-zA-Z0-9_]+)/g));
        for (const match of pMatches) {
          const col = match[1];
          if (!col) continue;
          if (!validPointerCols.has(col)) {
            const err = new Error(`column p.${col} does not exist`);
            Object.assign(err, { code: '42703' });
            throw err;
          }
        }

        // Se passar pela validação de schema, simula o retorno do Postgres
        // verificando se a projeção foi "p.id as flow_id"
        const hasCorrectProjection = /p\.id\s+as\s+flow_id/i.test(sql);
        return {
          rows: [
            {
              enrollment_id: 'enr-ai-active-1',
              organization_id: baseInput.tenantId,
              current_node_id: 'node-ai-active',
              ai_node_session: mockSession,
              flow_id: hasCorrectProjection ? pointerId : null,
            },
          ],
        };
      }),
    };

    // NÃO injeta findActiveAiNodeSession: obriga a executar defaultFindActiveAiNodeSession
    const res = await resolveTurnAuthority(
      dbFixture as never,
      {} as never,
      baseInput,
      {
        isAiNodeEnabled: true,
        isLeadInHandoff,
      },
    );

    expect(dbFixture.query).toHaveBeenCalledTimes(1);
    const firstCall = dbFixture.query.mock.calls[0];
    const executedSql = (firstCall?.[0] as string) ?? '';
    expect(executedSql).toContain('p.id as flow_id');
    expect(executedSql).not.toContain('p.flow_id');

    expect(res.authority).toBe('ai_node');
    if (res.authority === 'ai_node') {
      expect(res.enrollment_id).toBe('enr-ai-active-1');
      expect(res.flow_id).toBe(pointerId);
      expect(res.node_id).toBe('node-ai-active');
      expect(res.session).toEqual(mockSession);
    }
  });
});

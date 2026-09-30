import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeAiNodeTurn,
  type ExecuteAiNodeTurnInput,
} from '@/lib/followup/ai-node-executor';
import { filterAiNodeSafeTools, classifyAiNodeTool } from '@/lib/followup/ai-node-tools';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';
import type { AiNodeConfig } from '@/lib/followup/graph-schema';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import { LlmModeloIncompativelComProvedorError } from '@/lib/agent-engine/edge/llm/run-model-call';

describe('Node IA - Fase 3: Execução, Agentes Existentes, Fencing e Condições Determinísticas', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const enrollmentId = '22222222-2222-4222-8222-222222222222';
  const nodeId = 'node-ai-1';
  const inboundMessageId = '33333333-3333-4333-8333-333333333333';
  const agentId = '44444444-4444-4444-8444-444444444444';
  const versionPublishedId = '55555555-5555-4555-8555-555555555555';
  const versionPinnedId = '66666666-6666-4666-8666-666666666666';

  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
  });

  function buildMockSession(overrides: Partial<AiNodeSession> = {}): AiNodeSession {
    return {
      node_id: nodeId,
      mode: 'existing_agent',
      status: 'running',
      turn_count: 1,
      started_at: '2026-09-30T12:00:00Z',
      last_inbound_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
      ...overrides,
    };
  }

  const baseAgentConfig: PublishedAgentConfig = {
    agentId,
    versionId: versionPublishedId,
    agentName: 'Vinícius Especialista',
    systemPrompt: 'Você é o Vinícius. Apresente os pacotes com cordialidade e precisão.',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 15,
    historyTokenWindow: 2000,
    handoffKeywords: ['falar com atendente'],
    handoffToolEnabled: false,
    splitMessages: false,
    splitMaxChars: 400,
    multimodalInput: true,
    casesEnabled: false,
    toolIds: ['crm_list_pipelines', 'crm_move_lead', 'crm_get_lead'],
    knowledgeSourceIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.4,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    agentCreatedBy: null,
  };

  // =========================================================================
  // CASO A: existing_agent -> Carrega versão publicada correta
  // =========================================================================
  it('A: modo existing_agent carrega versão publicada atual do agente no turno', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const loadPinnedFn = vi.fn();
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Olá! Sou o Vinícius. Como posso te ajudar hoje?' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 100, outputTokens: 30 },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Quais os planos?',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      loadAgentVersionConfigFn: loadPinnedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    expect(loadPublishedFn).toHaveBeenCalledWith(mockDb, orgId, agentId);
    expect(loadPinnedFn).not.toHaveBeenCalled();
    expect(runModelCallFn).toHaveBeenCalledTimes(1);

    const callArgs = runModelCallFn.mock.calls[0]![2];
    expect(callArgs.system).toContain('Você é o Vinícius');
    expect(callArgs.model).toBe('claude-3-5-sonnet-20241022');
    expect(callArgs.llmOverride).toEqual({ provider: 'anthropic', credentialId: null });

    expect(res.status).toBe('generated');
    expect(res.reply).toBe('Olá! Sou o Vinícius. Como posso te ajudar hoje?');
    expect(res.agent_id).toBe(agentId);
    expect(res.agent_version_id).toBe(versionPublishedId);
    expect(res.cached).toBe(false);
  });

  // =========================================================================
  // CASO B: pinned -> Usa exatamente pinned_version_id
  // =========================================================================
  it('B: modo existing_agent com pinned usa exatamente pinned_version_id', async () => {
    const pinnedAgentConfig: PublishedAgentConfig = {
      ...baseAgentConfig,
      versionId: versionPinnedId,
      systemPrompt: 'Você é a versão Pinned 6666 congelada.',
    };

    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'pinned',
        pinned_version_id: versionPinnedId,
      },
    };

    const loadPublishedFn = vi.fn();
    const loadPinnedFn = vi.fn().mockResolvedValue(pinnedAgentConfig);
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Resposta da versão pinned congelada.' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 80, outputTokens: 25 },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({ agent_version_id: versionPinnedId }),
      inboundText: 'Olá!',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      loadAgentVersionConfigFn: loadPinnedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    expect(loadPinnedFn).toHaveBeenCalledWith(mockDb, orgId, agentId, versionPinnedId);
    expect(loadPublishedFn).not.toHaveBeenCalled();
    expect(res.status).toBe('generated');
    expect(res.agent_version_id).toBe(versionPinnedId);
    expect(runModelCallFn.mock.calls[0]![2].system).toContain('Você é a versão Pinned 6666 congelada');
  });

  // =========================================================================
  // CASO C: custom_prompt -> Funciona sem agent_id
  // =========================================================================
  it('C: modo custom_prompt funciona sem agent_id e sem carregar agente', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'custom_prompt',
      custom_prompt: 'Aja como assistente temporário. Peça o CEP para calcular a entrega.',
    };

    const loadPublishedFn = vi.fn();
    const loadPinnedFn = vi.fn();
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Por favor, me informe seu CEP para calcularmos a entrega.' },
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({ mode: 'custom_prompt' }),
      inboundText: 'Quanto fica o frete?',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      loadAgentVersionConfigFn: loadPinnedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    expect(loadPublishedFn).not.toHaveBeenCalled();
    expect(loadPinnedFn).not.toHaveBeenCalled();
    expect(res.status).toBe('generated');
    expect(res.agent_id).toBeUndefined();
    expect(res.agent_version_id).toBeUndefined();

    const callArgs = runModelCallFn.mock.calls[0]![2];
    expect(callArgs.agentId).toBeNull();
    expect(callArgs.llmOverride).toBeUndefined();
    expect(callArgs.system).toContain('Peça o CEP para calcular a entrega');
    expect(callArgs.tools).toBeUndefined(); // Zero tools no custom_prompt
  });

  // =========================================================================
  // CASO D: existing_with_supplementary -> Mantém prompt do agente + adiciona missão do node
  // =========================================================================
  it('D: existing_with_supplementary preserva prompt do agente e adiciona diretriz da etapa sem sobrescrever regras superiores', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_with_supplementary',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
      supplementary_instruction: 'Você está agora na etapa de fechamento. Não repita a apresentação. Foque em fechar o plano anual.',
      objective: 'Fechar plano anual',
      completion_condition: 'Cliente escolheu a forma de pagamento',
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Perfeito! Vamos finalizar com o plano anual?' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 120, outputTokens: 25 },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({ mode: 'existing_with_supplementary', turn_count: 2 }),
      inboundText: 'Gostei do plano anual.',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
      platformCompliance: 'Regra de Compliance: Não prometa descontos fora da tabela.',
    });

    expect(res.status).toBe('generated');
    const systemPrompt = runModelCallFn.mock.calls[0]![2].system;

    // 1. Compliance no topo
    expect(systemPrompt).toContain('Regra de Compliance: Não prometa descontos fora da tabela');
    // 2. Prompt base do agente
    expect(systemPrompt).toContain('Você é o Vinícius. Apresente os pacotes com cordialidade e precisão');
    // 3. Diretriz complementar da etapa
    expect(systemPrompt).toContain('Você está agora na etapa de fechamento. Não repita a apresentação');
    // 4. Objetivo do nó
    expect(systemPrompt).toContain('Fechar plano anual');
    // 5. Critério de conclusão
    expect(systemPrompt).toContain('Cliente escolheu a forma de pagamento');

    // Ordem de precedência: Compliance vem antes do agente, e agente vem antes do nó
    const complianceIdx = systemPrompt.indexOf('Regra de Compliance');
    const agentIdx = systemPrompt.indexOf('Você é o Vinícius');
    const suppIdx = systemPrompt.indexOf('Você está agora na etapa de fechamento');
    const objIdx = systemPrompt.indexOf('Fechar plano anual');

    expect(complianceIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(suppIdx);
    expect(suppIdx).toBeLessThan(objIdx);
  });

  // =========================================================================
  // CASO E: Agente pausado -> agent_unavailable -> zero LLM
  // =========================================================================
  it('E: agente pausado retorna agent_unavailable e não invoca LLM', async () => {
    const pausedAgent: PublishedAgentConfig = {
      ...baseAgentConfig,
      pausedAt: '2026-09-30T15:00:00Z',
    };

    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(pausedAgent);
    const runModelCallFn = vi.fn();

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Olá',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
    });

    expect(res.status).toBe('agent_unavailable');
    expect(res.reason).toBe('agent_paused');
    expect(runModelCallFn).not.toHaveBeenCalled();

    // Evento de observabilidade registrado no banco
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO followup_enrollment_events'),
      expect.arrayContaining(['ai_node.agent_unavailable']),
    );
  });

  // =========================================================================
  // CASO F: Agente arquivado / não encontrado -> agent_unavailable -> zero LLM
  // =========================================================================
  it('F: agente arquivado ou inexistente retorna agent_unavailable e zero LLM', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(null);
    const runModelCallFn = vi.fn();

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Olá',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
    });

    expect(res.status).toBe('agent_unavailable');
    expect(res.reason).toBe('agent_not_found_or_not_published');
    expect(runModelCallFn).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CASO G: Provider/model incompatível -> resolver canônico bloqueia
  // =========================================================================
  it('G: provider e model incompatíveis são bloqueados pelo seam canônico', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const runModelCallFn = vi.fn().mockRejectedValue(
      new LlmModeloIncompativelComProvedorError({
        provider: 'openai',
        model: 'claude-3-5-sonnet',
        purpose: 'ai_node',
      }),
    );

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Olá',
    };

    await expect(
      executeAiNodeTurn(mockDb, input, {
        loadPublishedAgentConfigByIdFn: loadPublishedFn,
        runModelCallFn,
        validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
        getReplyCacheFn: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toThrow(LlmModeloIncompativelComProvedorError);
  });

  // =========================================================================
  // CASO H: Condição determinística já cumprida -> deterministic_completed -> zero LLM
  // =========================================================================
  it('H: condição determinística suficiente cumprida retorna deterministic_completed com zero LLM', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
      deterministic_conditions: {
        min_images: 2,
      },
    };

    const runModelCallFn = vi.fn();
    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({
        media_summary: {
          images_count: 3, // >= 2: condição atingida!
          audios_count: 0,
          documents_count: 0,
          last_media_ids: ['img-1', 'img-2', 'img-3'],
        },
      }),
      inboundText: 'Aqui estão as fotos',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
    });

    expect(res.status).toBe('deterministic_completed');
    expect(res.deterministic_match).toContain('min_images');
    expect(runModelCallFn).not.toHaveBeenCalled();
    expect(loadPublishedFn).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CASO I: Crash / resumed com reply cache existente -> zero nova chamada LLM
  // =========================================================================
  it('I: turno retomado com resposta já existente no reply cache não chama LLM novamente', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const runModelCallFn = vi.fn();
    const getReplyCacheFn = vi.fn().mockResolvedValue({
      reply_text: 'Esta resposta já foi gerada antes do worker cair.',
      tokens_in: 150,
      tokens_out: 40,
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-2-takeover',
      leaseGeneration: 2,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Alguém aí?',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      getReplyCacheFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
    });

    expect(res.status).toBe('generated');
    expect(res.reply).toBe('Esta resposta já foi gerada antes do worker cair.');
    expect(res.cached).toBe(true);
    expect(runModelCallFn).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CASO J: Worker perde lease durante LLM -> resultado descartado
  // =========================================================================
  it('J: worker perde titularidade da lease durante a chamada LLM e o resultado é integralmente descartado', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Texto gerado por worker que perdeu a autoridade.' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 100, outputTokens: 30 },
    });

    // Pré-check OK; pós-check FALHA (takeover ocorreu enquanto a LLM rodava!)
    const validateOwnershipFn = vi
      .fn()
      .mockResolvedValueOnce({ is_valid: true })
      .mockResolvedValueOnce({ is_valid: false, reason: 'stale_lease_owner' });

    const recordReplyFn = vi.fn();

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-A',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Como funciona?',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn,
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn,
    });

    expect(res.status).toBe('stale_lease_owner');
    // Não gravou resposta no cache nem retornou texto
    expect(recordReplyFn).not.toHaveBeenCalled();
    expect(res.reply).toBeUndefined();

    // Evento de auditoria de descarte gravado
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO followup_enrollment_events'),
      expect.arrayContaining(['ai_node.stale_worker']),
    );
  });

  // =========================================================================
  // CASO K: Heartbeat mantém lease em chamada longa (>60s)
  // =========================================================================
  it('K: heartbeat mantém lease viva chamando renovação periodicamente durante operação longa', async () => {
    vi.useFakeTimers();

    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const renewLeaseFn = vi.fn().mockResolvedValue({
      status: 'renewed',
      lease_until: '2026-09-30T12:02:00Z',
      lease_generation: 1,
      worker_id: 'worker-long',
    });

    // Simula uma chamada que demora avançando timers
    const runModelCallFn = vi.fn().mockImplementation(async () => {
      // Avança 45 segundos (2 ciclos de heartbeat de 20s)
      await vi.advanceTimersByTimeAsync(45_000);
      return {
        result: { text: 'Concluído após 45 segundos.' },
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-long',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Processamento longo',
    };

    const turnPromise = executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      renewLeaseFn,
      heartbeatIntervalMs: 20_000,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    const res = await turnPromise;
    expect(res.status).toBe('generated');
    expect(renewLeaseFn).toHaveBeenCalled();
    expect(renewLeaseFn.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  // =========================================================================
  // CASO L: Stale worker tenta registrar resposta -> rejeitado por fencing token
  // =========================================================================
  it('L: recordReply rejeita tentativa de gravação quando generation ou workerId diferem', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Tentando gravar resposta vencida.' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const recordReplyFn = vi.fn().mockResolvedValue({
      recorded: false,
      error: 'stale_lease_owner',
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-outdated',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession(),
      inboundText: 'Teste',
    };

    const res = await executeAiNodeTurn(mockDb, input, {
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn,
    });

    expect(res.status).toBe('stale_lease_owner');
    expect(res.reason).toBe('record_reply_rejected_due_to_stale_owner');
  });

  // =========================================================================
  // CASO M: custom_prompt não recebe tools
  // =========================================================================
  it('M: custom_prompt não herda nem recebe tools externas', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'custom_prompt',
      objective: 'Responder apenas com orientações gerais',
    };

    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Orientações gerais fornecidas.' },
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      usage: { inputTokens: 50, outputTokens: 10 },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({ mode: 'custom_prompt' }),
      inboundText: 'Como funciona a garantia?',
    };

    await executeAiNodeTurn(mockDb, input, {
      runModelCallFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    const callArgs = runModelCallFn.mock.calls[0]![2];
    expect(callArgs.tools).toBeUndefined();
  });

  // =========================================================================
  // CASO N: Tool mutável não autorizada no Node IA -> bloqueada
  // =========================================================================
  it('N: tools mutáveis com efeito colateral são bloqueadas no Node IA (apenas read-only permitidas)', () => {
    const mixedTools = [
      'crm_list_pipelines', // read
      'crm_get_lead', // read
      'crm_create_lead', // write -> BLOQUEADA
      'crm_move_lead', // write -> BLOQUEADA
      'crm_book_appointment', // write -> BLOQUEADA
      'crm_request_human_handoff', // handoff -> BLOQUEADA
      'crm_find_free_slots', // read
    ];

    const { safeToolNames, blockedToolNames } = filterAiNodeSafeTools(mixedTools);

    expect(safeToolNames).toEqual(['crm_list_pipelines', 'crm_get_lead', 'crm_find_free_slots']);
    expect(blockedToolNames).toEqual([
      'crm_create_lead',
      'crm_move_lead',
      'crm_book_appointment',
      'crm_request_human_handoff',
    ]);

    // Verifica classificação individual
    const bookCheck = classifyAiNodeTool('crm_book_appointment');
    expect(bookCheck.statusNodeIa).toBe('blocked');
    expect(bookCheck.isMutable).toBe(true);
    expect(bookCheck.safeUnderLease).toBe(false);

    const slotsCheck = classifyAiNodeTool('crm_find_free_slots');
    expect(slotsCheck.statusNodeIa).toBe('allowed');
    expect(slotsCheck.isReadOnly).toBe(true);
    expect(slotsCheck.safeUnderLease).toBe(true);
  });

  // =========================================================================
  // CASO O: Conversa preserva contexto anterior do Fluxo
  // =========================================================================
  it('O: conversa preserva histórico recente carregado pelo getLeadContext e inclui inbound atual', async () => {
    const nodeConfig: AiNodeConfig = {
      mode: 'existing_agent',
      agent_binding: {
        agent_id: agentId,
        version_strategy: 'published',
      },
    };

    const loadPublishedFn = vi.fn().mockResolvedValue(baseAgentConfig);
    const runModelCallFn = vi.fn().mockResolvedValue({
      result: { text: 'Perfeito! Anotei seu e-mail.' },
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { inputTokens: 150, outputTokens: 20 },
    });

    const getLeadContextFn = vi.fn().mockResolvedValue({
      ok: true,
      context: {
        lead_id: 'lead-1',
        contact: { name: 'Mariana', phone: '11999999999', tags: ['vip'], is_blocked: false },
        conversation_id: 'conv-1',
        last_human_decision: null,
        messages: [
          { direction: 'inbound', body: 'Quero conhecer o produto', sent_at: '2026-09-30T10:00:00Z' },
          { direction: 'outbound', body: 'Com certeza! Temos 3 planos disponíveis.', sent_at: '2026-09-30T10:01:00Z' },
        ],
      },
    });

    const input: ExecuteAiNodeTurnInput = {
      organizationId: orgId,
      enrollmentId,
      nodeId,
      inboundMessageId,
      contactId: 'lead-1',
      conversationId: 'conv-1',
      workerId: 'worker-1',
      leaseGeneration: 1,
      nodeConfig,
      session: buildMockSession({ turn_count: 2 }),
      inboundText: 'Meu e-mail é mariana@empresa.com',
    };

    await executeAiNodeTurn(mockDb, input, {
      crmCfg: { supabase: {} as any } as any,
      loadPublishedAgentConfigByIdFn: loadPublishedFn,
      runModelCallFn,
      getLeadContextFn,
      validateOwnershipFn: vi.fn().mockResolvedValue({ is_valid: true }),
      getReplyCacheFn: vi.fn().mockResolvedValue(null),
      recordReplyFn: vi.fn().mockResolvedValue({ recorded: true }),
    });

    const callArgs = runModelCallFn.mock.calls[0]![2];
    const messages = callArgs.messages;

    expect(messages.length).toBe(3);
    expect(messages[0]).toEqual({ role: 'user', content: 'Quero conhecer o produto' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Com certeza! Temos 3 planos disponíveis.' });
    expect(messages[2]).toEqual({ role: 'user', content: 'Meu e-mail é mariana@empresa.com' });
  });
});

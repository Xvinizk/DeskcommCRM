/**
 * Executor do Node IA (Fase 3).
 *
 * Responsável pelo ciclo de execução do Node IA:
 * 1. Reutilização segura de Agentes existentes (published vs pinned).
 * 2. Suporte aos 3 modos: existing_agent, custom_prompt, existing_with_supplementary.
 * 3. Validação estrita em runtime (agente pausado, arquivado, versão inválida -> agent_unavailable).
 * 4. Avaliação preliminar de condições determinísticas (min_images, require_audio, tags -> deterministic_completed).
 * 5. Composição de prompt em 7 camadas (compliance -> agente -> complementar -> objetivo -> conclusão -> fatos -> histórico).
 * 6. Resolução canônica de provider/model via runModelCall (proteção contra pares incompatíveis e limites de orçamento).
 * 7. Heartbeat ativo durante a chamada LLM + Fencing pré e pós LLM com descarte em caso de perda de autoridade.
 * 8. Consulta e gravação em reply cache (recordAiNodeReplyGenerated / getAiNodeGeneratedReply).
 * 9. Auditoria e bloqueio de tools mutáveis (apenas tools read-only permitidas nos modos com agente).
 * 10. ZERO envio real de WhatsApp nesta fase.
 */
import type pg from 'pg';
import type { ModelMessage, ToolSet } from 'ai';

import {
  loadPublishedAgentConfigById,
  loadAgentVersionConfig,
  type PublishedAgentConfig,
} from '@/lib/agent-engine/agent/agent-config';
import {
  runModelCall,
  type RunModelCallInput,
} from '@/lib/agent-engine/edge/llm/run-model-call';
import {
  getLeadContext,
  type LeadContextKnobs,
  type LeadContextResult,
} from '@/lib/agent-engine/edge/crm/get-lead-context';
import type { CrmEdgeConfig } from '@/lib/agent-engine/edge/crm/mcp-client';
import type { LlmEdgeConfig } from '@/lib/agent-engine/edge/llm/credentials';
import type { ProviderRegistry } from '@/lib/agent-engine/edge/llm/providers';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import { pickToolsFromMcp } from '@/lib/ai/runtime/tools';
import type { McpAuthResult } from '@/lib/mcp/auth';
import type { Actor } from '@/lib/api/handlers/types';

import {
  validateAiNodeTurnOwnership,
  renewAiNodeTurnLease,
  recordAiNodeReplyGenerated,
  getAiNodeGeneratedReply,
  type DbPoolLike,
} from './ai-node-idempotency';
import type { AiNodeSession, AiNodeSessionMediaSummary } from './ai-node-session';
import {
  aiNodeConfigSchema,
  flowGraphSchema,
  type AiNodeConfig,
  type AiNodeDeterministicConditions,
} from './graph-schema';
import { filterAiNodeSafeTools } from './ai-node-tools';

export const DEFAULT_PLATFORM_COMPLIANCE =
  'Diretriz de Compliance da Plataforma: Seja sempre cortês, profissional e respeite a privacidade dos dados do cliente (LGPD). Nunca invente fatos não confirmados pelo sistema.';

export interface ExecuteAiNodeTurnInput {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
  conversationId?: string | null;
  contactId?: string | null;
  workerId: string;
  leaseGeneration: number;
  /** Configuração do nó já resolvida (opcional para testes ou runtime pré-carregado) */
  nodeConfig?: AiNodeConfig;
  /** Sessão do nó já resolvida */
  session?: AiNodeSession;
  /** Mensagem inbound crua enviada pelo cliente no turno atual */
  inboundText?: string | null;
}

export interface ExecuteAiNodeTurnResult {
  status:
    | 'generated'
    | 'deterministic_completed'
    | 'agent_unavailable'
    | 'stale_lease_owner'
    | 'error';
  reply?: string;
  agent_id?: string;
  agent_version_id?: string;
  provider?: string;
  model?: string;
  reason?: string;
  deterministic_match?: string;
  cached?: boolean;
}

export interface ExecuteAiNodeTurnDeps {
  runModelCallFn?: typeof runModelCall;
  loadPublishedAgentConfigByIdFn?: typeof loadPublishedAgentConfigById;
  loadAgentVersionConfigFn?: typeof loadAgentVersionConfig;
  getLeadContextFn?: typeof getLeadContext;
  validateOwnershipFn?: typeof validateAiNodeTurnOwnership;
  renewLeaseFn?: typeof renewAiNodeTurnLease;
  getReplyCacheFn?: typeof getAiNodeGeneratedReply;
  recordReplyFn?: typeof recordAiNodeReplyGenerated;
  clock?: () => Date;
  heartbeatIntervalMs?: number;
  log?: Logger;
  crmCfg?: CrmEdgeConfig;
  llmCfg?: LlmEdgeConfig;
  registry?: ProviderRegistry;
  platformCompliance?: string;
}

/**
 * Avalia se condições determinísticas prévias foram atendidas pelo estado atual.
 */
export function evaluateAiNodeDeterministicConditions(
  conditions: AiNodeDeterministicConditions | undefined,
  facts: {
    mediaSummary?: AiNodeSessionMediaSummary;
    tags?: string[];
    stageId?: string | null;
  },
): { satisfied: boolean; match?: string } {
  if (!conditions) return { satisfied: false };

  // Tratamento de formato de objeto de condições
  const c = conditions as Record<string, unknown>;

  if (typeof c.min_images === 'number') {
    const imagesCount = facts.mediaSummary?.images_count ?? 0;
    if (imagesCount >= c.min_images) {
      return { satisfied: true, match: `min_images (recebido: ${imagesCount}, exigido: ${c.min_images})` };
    }
  }

  if (c.require_audio === true) {
    const audiosCount = facts.mediaSummary?.audios_count ?? 0;
    if (audiosCount >= 1) {
      return { satisfied: true, match: `require_audio (recebido: ${audiosCount})` };
    }
  }

  if (c.require_document === true) {
    const docsCount = facts.mediaSummary?.documents_count ?? 0;
    if (docsCount >= 1) {
      return { satisfied: true, match: `require_document (recebido: ${docsCount})` };
    }
  }

  const tagExpected = (c.tag_exists ?? c.lead_tag) as string | undefined;
  if (tagExpected && typeof tagExpected === 'string') {
    if (facts.tags && facts.tags.includes(tagExpected)) {
      return { satisfied: true, match: `lead_tag (${tagExpected})` };
    }
  }

  if (typeof c.stage_id === 'string') {
    if (facts.stageId === c.stage_id) {
      return { satisfied: true, match: `stage_id (${c.stage_id})` };
    }
  }

  return { satisfied: false };
}

/**
 * Resolve e valida o agente em runtime, checando integridade de versão, status de pausa e arquivamento.
 */
export async function resolveAiNodeAgentConfig(
  db: pg.Pool,
  organizationId: string,
  nodeConfig: AiNodeConfig,
  deps: {
    loadPublishedAgentConfigByIdFn?: typeof loadPublishedAgentConfigById;
    loadAgentVersionConfigFn?: typeof loadAgentVersionConfig;
  } = {},
): Promise<
  | { ok: true; agent: PublishedAgentConfig | null; mode: AiNodeConfig['mode'] }
  | { ok: false; status: 'agent_unavailable'; reason: string; agentId?: string }
> {
  if (nodeConfig.mode === 'custom_prompt') {
    return { ok: true, agent: null, mode: 'custom_prompt' };
  }

  const binding = nodeConfig.agent_binding;
  if (!binding?.agent_id) {
    return { ok: false, status: 'agent_unavailable', reason: 'missing_agent_id' };
  }

  const loadPublished = deps.loadPublishedAgentConfigByIdFn ?? loadPublishedAgentConfigById;
  const loadVersion = deps.loadAgentVersionConfigFn ?? loadAgentVersionConfig;

  let agent: PublishedAgentConfig | null = null;

  if (binding.version_strategy === 'pinned') {
    if (!binding.pinned_version_id) {
      return {
        ok: false,
        status: 'agent_unavailable',
        reason: 'missing_pinned_version_id',
        agentId: binding.agent_id,
      };
    }
    agent = await loadVersion(db, organizationId, binding.agent_id, binding.pinned_version_id);
    if (!agent) {
      return {
        ok: false,
        status: 'agent_unavailable',
        reason: 'pinned_version_not_found_or_archived',
        agentId: binding.agent_id,
      };
    }
    if (agent.versionId !== binding.pinned_version_id) {
      return {
        ok: false,
        status: 'agent_unavailable',
        reason: 'pinned_version_mismatch',
        agentId: binding.agent_id,
      };
    }
  } else {
    // strategy: 'published'
    agent = await loadPublished(db, organizationId, binding.agent_id);
    if (!agent) {
      return {
        ok: false,
        status: 'agent_unavailable',
        reason: 'agent_not_found_or_not_published',
        agentId: binding.agent_id,
      };
    }
  }

  // Validação em voo: se o agente foi pausado
  if (agent.pausedAt) {
    return {
      ok: false,
      status: 'agent_unavailable',
      reason: 'agent_paused',
      agentId: binding.agent_id,
    };
  }

  return { ok: true, agent, mode: nodeConfig.mode };
}

/**
 * Compõe o prompt do sistema respeitando a ordem canônica das 7 camadas:
 * 1. Plataforma / compliance
 * 2. Agente publicado (se houver)
 * 3. Instrução complementar do Node (se houver)
 * 4. Objetivo do Node (se houver)
 * 5. Condição de conclusão como contexto da missão
 * 6. Fatos determinísticos disponíveis do sistema
 */
export function composeAiNodeSystemPrompt(params: {
  platformCompliance?: string;
  agentSystemPrompt?: string;
  supplementaryInstruction?: string;
  objective?: string;
  customPrompt?: string;
  completionCondition?: string;
  systemFacts?: string;
}): string {
  const parts: string[] = [];

  // Camada 1: Plataforma / compliance
  const platform = (params.platformCompliance ?? DEFAULT_PLATFORM_COMPLIANCE).trim();
  if (platform) {
    parts.push(`## Regras de Plataforma e Compliance\n${platform}`);
  }

  // Camada 2: Agente publicado
  const agentPrompt = (params.agentSystemPrompt ?? '').trim();
  if (agentPrompt) {
    parts.push(`## Instruções do Agente\n${agentPrompt}`);
  }

  // Camada 3: Instrução complementar do Node
  const supplementary = (params.supplementaryInstruction ?? '').trim();
  if (supplementary) {
    parts.push(`## Diretriz Complementar da Etapa Atual\n${supplementary}`);
  }

  // Camada 4: Objetivo do Node
  const objective = (params.objective ?? '').trim();
  if (objective) {
    parts.push(`## Objetivo do Nó\n${objective}`);
  }

  const customPrompt = (params.customPrompt ?? '').trim();
  if (customPrompt) {
    parts.push(`## Instrução Específica do Nó\n${customPrompt}`);
  }

  // Camada 5: Condição de conclusão como contexto da missão
  const completion = (params.completionCondition ?? '').trim();
  if (completion) {
    parts.push(`## Critério de Conclusão da Missão\n${completion}`);
  }

  // Camada 6: Fatos determinísticos do sistema
  const facts = (params.systemFacts ?? '').trim();
  if (facts) {
    parts.push(`## Fatos do Sistema\n${facts}`);
  }

  return parts.join('\n\n');
}

/**
 * Constrói o bloco de fatos do sistema calculados deterministicamente.
 */
export function formatAiNodeSystemFacts(params: {
  mediaSummary?: AiNodeSessionMediaSummary;
  turnCount?: number;
}): string {
  const media = params.mediaSummary ?? { images_count: 0, audios_count: 0, documents_count: 0, last_media_ids: [] };
  const turns = params.turnCount ?? 1;

  return [
    `- Imagens recebidas neste nó: ${media.images_count}`,
    `- Áudios recebidos neste nó: ${media.audios_count}`,
    `- Documentos recebidos neste nó: ${media.documents_count}`,
    `- Turno atual na etapa: ${turns}`,
  ].join('\n');
}

/**
 * Carrega a configuração do Node IA a partir do graph do fluxo persistido no banco.
 */
async function loadAiNodeConfigFromDb(
  db: DbPoolLike,
  organizationId: string,
  enrollmentId: string,
  nodeId: string,
): Promise<{
  nodeConfig: AiNodeConfig;
  session: AiNodeSession;
  contactId: string;
  conversationId: string | null;
  stageId: string | null;
  tags: string[];
} | null> {
  const { rows } = await db.query<{
    current_node_id: string;
    contact_id: string;
    conversation_id: string | null;
    ai_node_session: AiNodeSession | null;
    graph: unknown;
  }>(
    `SELECT e.current_node_id, e.contact_id, e.conversation_id, e.ai_node_session, v.graph
     FROM followup_enrollments e
     JOIN followup_flow_versions v ON v.id = e.version_id
     WHERE e.organization_id = $1 AND e.id = $2`,
    [organizationId, enrollmentId],
  );

  const row = rows[0];
  if (!row || !row.ai_node_session) return null;

  let graphParsed;
  try {
    graphParsed = flowGraphSchema.parse(row.graph);
  } catch {
    return null;
  }

  const targetNode = graphParsed.nodes.find((n) => n.id === nodeId && n.type === 'ai_node');
  if (!targetNode) return null;

  const nodeConfig = aiNodeConfigSchema.parse(targetNode.config);

  // Consulta dados do lead (stage_id e tags)
  let stageId: string | null = null;
  let tags: string[] = [];
  try {
    const { rows: leadRows } = await db.query<{ stage_id: string | null; tags: string[] }>(
      `SELECT stage_id, tags FROM crm_leads WHERE organization_id = $1 AND contact_id = $2 ORDER BY updated_at DESC LIMIT 1`,
      [organizationId, row.contact_id],
    );
    if (leadRows[0]) {
      stageId = leadRows[0].stage_id;
      tags = leadRows[0].tags ?? [];
    }
  } catch {
    // Silencia erro de leitura de lead secundária
  }

  return {
    nodeConfig,
    session: row.ai_node_session,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    stageId,
    tags,
  };
}

/**
 * Executa o turno do Node IA com todas as garantias de ciclo de vida da Fase 3.
 */
export async function executeAiNodeTurn(
  db: DbPoolLike,
  input: ExecuteAiNodeTurnInput,
  deps: ExecuteAiNodeTurnDeps = {},
): Promise<ExecuteAiNodeTurnResult> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000;

  const getReplyCache = deps.getReplyCacheFn ?? getAiNodeGeneratedReply;
  const recordReply = deps.recordReplyFn ?? recordAiNodeReplyGenerated;
  const validateOwnership = deps.validateOwnershipFn ?? validateAiNodeTurnOwnership;
  const renewLease = deps.renewLeaseFn ?? renewAiNodeTurnLease;
  const runModelCallSeam = deps.runModelCallFn ?? runModelCall;

  // 1. Resolver NodeConfig, Session e dados do Lead
  let nodeConfig = input.nodeConfig;
  let session = input.session;
  let contactId = input.contactId ?? null;
  let conversationId = input.conversationId ?? null;
  let stageId: string | null = null;
  let tags: string[] = [];

  if (!nodeConfig || !session) {
    const loaded = await loadAiNodeConfigFromDb(
      db,
      input.organizationId,
      input.enrollmentId,
      input.nodeId,
    );
    if (!loaded) {
      return {
        status: 'error',
        reason: 'node_config_or_session_not_found',
      };
    }
    nodeConfig = nodeConfig ?? loaded.nodeConfig;
    session = session ?? loaded.session;
    contactId = contactId ?? loaded.contactId;
    conversationId = conversationId ?? loaded.conversationId;
    stageId = loaded.stageId;
    tags = loaded.tags;
  }

  // 2. REPLY CACHE: Verificar se este turno já gerou resposta (Crash / Resumed)
  const cachedReply = await getReplyCache(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
  });

  if (cachedReply) {
    return {
      status: 'generated',
      reply: cachedReply.reply_text,
      cached: true,
      agent_id: session.agent_id ?? undefined,
      agent_version_id: session.agent_version_id ?? undefined,
    };
  }

  // 3. CONDIÇÕES DETERMINÍSTICAS: Avaliar antes de tocar na LLM
  const deterministicEval = evaluateAiNodeDeterministicConditions(
    nodeConfig.deterministic_conditions,
    {
      mediaSummary: session.media_summary,
      tags,
      stageId,
    },
  );

  if (deterministicEval.satisfied) {
    return {
      status: 'deterministic_completed',
      deterministic_match: deterministicEval.match,
      agent_id: session.agent_id ?? undefined,
      agent_version_id: session.agent_version_id ?? undefined,
    };
  }

  // 4. RESOLVER E VALIDAR AGENTE EM RUNTIME
  const agentResolution = await resolveAiNodeAgentConfig(
    db as unknown as pg.Pool,
    input.organizationId,
    nodeConfig,
    {
      loadPublishedAgentConfigByIdFn: deps.loadPublishedAgentConfigByIdFn,
      loadAgentVersionConfigFn: deps.loadAgentVersionConfigFn,
    },
  );

  if (!agentResolution.ok) {
    // Registra evento explícito de observabilidade
    try {
      await db.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          'ai_node.agent_unavailable',
          JSON.stringify({
            inbound_message_id: input.inboundMessageId,
            reason: agentResolution.reason,
            agent_id: agentResolution.agentId ?? null,
            worker_id: input.workerId,
            lease_generation: input.leaseGeneration,
          }),
          null,
          nowIso,
        ],
      );
    } catch {
      // Ignora erro no log de auditoria
    }

    return {
      status: 'agent_unavailable',
      reason: agentResolution.reason,
      agent_id: agentResolution.agentId,
    };
  }

  const agentConfig = agentResolution.agent;

  // 5. AUDITORIA E FILTRAGEM DE TOOLS
  // Modo custom_prompt: zero tools.
  // Modos com agente: somente tools categoria 'read' do catálogo MCP.
  let allowedTools: ToolSet | undefined = undefined;
  if (agentConfig && agentConfig.toolIds.length > 0) {
    const { safeToolNames } = filterAiNodeSafeTools(agentConfig.toolIds);
    if (deps.crmCfg?.supabase && safeToolNames.length > 0) {
      const actor: Actor = {
        type: 'ai_agent',
        id: agentConfig.agentId,
        role: 'agent',
        agent_id: agentConfig.agentId,
      };
      const authStub: McpAuthResult = {
        organizationId: input.organizationId,
        role: 'agent',
        actor,
        apiTokenId: 'ai-node-internal',
        scopes: ['mcp:read'],
      };
      allowedTools = pickToolsFromMcp({
        supabase: deps.crmCfg.supabase,
        ctx: {
          organizationId: input.organizationId,
          role: 'agent',
          actor,
          apiTokenId: 'ai-node-internal',
          requestId: input.inboundMessageId,
          supabase: deps.crmCfg.supabase,
        },
        auth: authStub,
        toolIds: safeToolNames,
        handoffToolEnabled: false,
        handoffSignal: { triggered: false },
      });
    }
  }

  // 6. FENCING PRÉ-LLM: Validar se ainda é o proprietário legítimo da lease
  const preCheck = await validateOwnership(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
    workerId: input.workerId,
    leaseGeneration: input.leaseGeneration,
  });

  if (!preCheck.is_valid) {
    try {
      await db.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          'ai_node.stale_worker',
          JSON.stringify({
            stage: 'pre_llm',
            inbound_message_id: input.inboundMessageId,
            worker_id: input.workerId,
            lease_generation: input.leaseGeneration,
            reason: preCheck.reason,
          }),
          null,
          nowIso,
        ],
      );
    } catch {}

    return {
      status: 'stale_lease_owner',
      reason: preCheck.reason ?? 'pre_llm_ownership_invalid',
    };
  }

  // 7. COMPOSIÇÃO DO PROMPT (7 Camadas)
  const systemFacts = formatAiNodeSystemFacts({
    mediaSummary: session.media_summary,
    turnCount: session.turn_count,
  });

  const composedSystemPrompt = composeAiNodeSystemPrompt({
    platformCompliance: deps.platformCompliance,
    agentSystemPrompt: agentConfig?.systemPrompt,
    supplementaryInstruction: nodeConfig.supplementary_instruction,
    objective: nodeConfig.objective,
    customPrompt: nodeConfig.custom_prompt,
    completionCondition: nodeConfig.completion_condition,
    systemFacts,
  });

  // 8. HISTÓRICO DA CONVERSA
  let messages: ModelMessage[] = [];
  if (contactId && deps.getLeadContextFn && deps.crmCfg) {
    try {
      const leadCtxResult: LeadContextResult = await deps.getLeadContextFn(
        db as unknown as pg.Pool,
        deps.crmCfg,
        {
          tenantId: input.organizationId,
          leadId: contactId,
          conversationId,
          fuso: 'America/Sao_Paulo',
        },
        {
          historyLimit: agentConfig?.historyMessageWindow ?? 15,
          maxTokens: agentConfig?.historyTokenWindow ?? 2000,
        },
      );

      if (leadCtxResult.ok) {
        messages = leadCtxResult.context.messages.map((m) => ({
          role: m.direction === 'inbound' ? 'user' : 'assistant',
          content: m.body,
        }));
      }
    } catch {
      // Fallback gracioso se a busca de contexto falhar
    }
  }

  // Garante que a mensagem inbound atual esteja presente
  if (input.inboundText) {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== input.inboundText) {
      messages.push({ role: 'user', content: input.inboundText });
    }
  } else if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Olá' });
  }

  // 9. LEASE KEEPER / HEARTBEAT E EXECUÇÃO DA LLM
  const abortController = new AbortController();
  let lostOwnership = false;

  const heartbeatInterval = setInterval(async () => {
    try {
      const renewResult = await renewLease(db, {
        organizationId: input.organizationId,
        enrollmentId: input.enrollmentId,
        nodeId: input.nodeId,
        inboundMessageId: input.inboundMessageId,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
        renewDurationMs: 60_000,
      });

      if (renewResult.status === 'stale_lease_owner') {
        lostOwnership = true;
        abortController.abort();
      }
    } catch {
      // Ignora falhas esporádicas de renovação
    }
  }, heartbeatIntervalMs);

  let generatedText = '';
  let modelResult;

  try {
    const callInput: RunModelCallInput = {
      tenantId: input.organizationId,
      leadId: contactId,
      jobId: null,
      agentId: agentConfig?.agentId ?? null,
      purpose: 'ai_node',
      system: composedSystemPrompt,
      messages,
      tools: allowedTools,
      abortSignal: abortController.signal,
      ...(agentConfig
        ? {
            model: agentConfig.model,
            llmOverride: {
              provider: agentConfig.provider,
              credentialId: agentConfig.credentialId,
            },
          }
        : {}),
    };

    modelResult = await runModelCallSeam(
      db as unknown as pg.Pool,
      deps.llmCfg ?? ({} as LlmEdgeConfig),
      callInput,
      {
        registry: deps.registry,
        log: deps.log,
      },
    );

    generatedText = modelResult.result.text ?? '';
  } catch (err: unknown) {
    // Se a chamada foi cancelada por perda de lease
    if (lostOwnership || (err instanceof Error && err.name === 'AbortError')) {
      return {
        status: 'stale_lease_owner',
        reason: 'aborted_during_llm_due_to_stale_owner',
      };
    }
    throw err;
  } finally {
    clearInterval(heartbeatInterval);
  }

  // 10. FENCING PÓS-LLM: Validar autoridade antes de usar o resultado
  const postCheck = await validateOwnership(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
    workerId: input.workerId,
    leaseGeneration: input.leaseGeneration,
  });

  if (!postCheck.is_valid || lostOwnership) {
    // CENÁRIO CRÍTICO: Worker A perdeu a lease durante a chamada de LLM.
    // O resultado DEVE SER DESCARTADO integralmente!
    try {
      await db.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          'ai_node.stale_worker',
          JSON.stringify({
            stage: 'post_llm_discard',
            inbound_message_id: input.inboundMessageId,
            worker_id: input.workerId,
            lease_generation: input.leaseGeneration,
            reason: postCheck.reason ?? 'ownership_lost_during_call',
          }),
          null,
          nowIso,
        ],
      );
    } catch {}

    return {
      status: 'stale_lease_owner',
      reason: 'ownership_lost_during_llm_call_result_discarded',
    };
  }

  // 11. RECORD REPLY GENERATED: Gravar no reply cache com fencing token
  const recordRes = await recordReply(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
    replyText: generatedText,
    workerId: input.workerId,
    leaseGeneration: input.leaseGeneration,
    tokensIn: modelResult.usage.inputTokens,
    tokensOut: modelResult.usage.outputTokens,
  });

  if (!recordRes.recorded && recordRes.error === 'stale_lease_owner') {
    return {
      status: 'stale_lease_owner',
      reason: 'record_reply_rejected_due_to_stale_owner',
    };
  }

  // 12. RETORNO DE SUCESSO (ZERO envio WhatsApp nesta Fase 3)
  return {
    status: 'generated',
    reply: generatedText,
    agent_id: agentConfig?.agentId,
    agent_version_id: agentConfig?.versionId,
    provider: modelResult.provider,
    model: modelResult.model,
    cached: false,
  };
}

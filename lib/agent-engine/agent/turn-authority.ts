import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { isLeadInHandoff } from './human-handoff';
import {
  resolveConversationTurn,
  type TurnAgentResolution,
  type ResolveTurnAgentDeps,
} from './resolve-turn-agent';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';
import type { PublishedAgentConfig } from './agent-config';

export type TurnAuthorityType =
  | 'human'
  | 'ai_node'
  | 'intent_router'
  | 'session_agent'
  | 'fallback';

export interface ResolveTurnAuthorityInput {
  tenantId: string;
  leadId: string;
  jobId: string;
  conversationId: string;
  channelSessionId: string;
  inboundMessageId?: string | null;
  inboundText?: string | null;
}

export type TurnAuthorityResult =
  | {
      authority: 'human';
      reason: string;
    }
  | {
      authority: 'ai_node';
      enrollment_id: string;
      flow_id: string | null;
      node_id: string;
      agent_id: string | null;
      agent_version_id: string | null;
      inbound_message_id: string | null;
      session: AiNodeSession;
    }
  | {
      authority: 'intent_router' | 'session_agent' | 'fallback';
      resolution: TurnAgentResolution;
      config: PublishedAgentConfig | null;
    };

export interface ResolveTurnAuthorityDeps extends Partial<ResolveTurnAgentDeps> {
  log?: Logger;
  isAiNodeEnabled?: boolean;
  isLeadInHandoff?: typeof isLeadInHandoff;
  resolveConversationTurn?: typeof resolveConversationTurn;
  findActiveAiNodeSession?: (
    db: pg.Pool,
    tenantId: string,
    leadId: string,
    conversationId?: string,
  ) => Promise<{
    enrollment_id: string;
    flow_id: string | null;
    node_id: string;
    session: AiNodeSession;
  } | null>;
}

/**
 * Consulta no banco se há um enrollment vivo em Node IA para o contato.
 */
async function defaultFindActiveAiNodeSession(
  db: pg.Pool,
  tenantId: string,
  leadId: string,
  conversationId?: string,
): Promise<{
  enrollment_id: string;
  flow_id: string | null;
  node_id: string;
  session: AiNodeSession;
} | null> {
  const { rows } = await db.query<{
    enrollment_id: string;
    flow_id: string | null;
    current_node_id: string;
    organization_id: string;
    ai_node_session: AiNodeSession | null;
  }>(
    `SELECT 
       e.id as enrollment_id,
       e.organization_id,
       e.current_node_id,
       e.ai_node_session,
       p.id as flow_id
     FROM followup_enrollments e
     LEFT JOIN followup_flow_pointers p ON p.id = e.pointer_id
     WHERE e.organization_id = $1
       AND e.contact_id = $2
       AND e.status IN ('active', 'waiting_reply')
       AND e.ai_node_session IS NOT NULL
     ORDER BY 
       CASE WHEN e.conversation_id = $3 THEN 0 ELSE 1 END,
       e.updated_at DESC
     LIMIT 1`,
    [tenantId, leadId, conversationId ?? null],
  );

  const row = rows[0];
  if (!row || !row.ai_node_session) return null;

  const session = row.ai_node_session;
  // Validações obrigatórias de segurança multi-tenant e integridade de nó
  if (row.organization_id !== tenantId) return null;
  if (session.node_id !== row.current_node_id) return null;
  if (session.status !== 'running') return null;

  return {
    enrollment_id: row.enrollment_id,
    flow_id: row.flow_id ?? session.flow_id ?? null,
    node_id: session.node_id,
    session,
  };
}

/**
 * Resolve canonicamente a autoridade para responder a um turno inbound.
 *
 * Hierarquia de Decisão (Fase 2):
 * 1. Humano assumiu a conversa -> IA não responde (`authority: "human"`)
 * 2. Enrollment ativo em Node IA + Feature Flag ativa -> `authority: "ai_node"`
 * 3. Sem Node IA ativo -> Intent Router / rotas existentes (`authority: "intent_router"`)
 * 4. Sem router aplicável -> Agente publicado da sessão (`authority: "session_agent"`)
 * 5. Fallback da organização/plataforma (`authority: "fallback"`)
 *
 * Se a feature flag FOLLOWUP_AI_NODE_ENABLED estiver desligada,
 * o Node IA NUNCA é consultado/ativado e o comportamento é 100% legado.
 */
export async function resolveTurnAuthority(
  db: pg.Pool,
  llmCfg: LlmEdgeConfig,
  input: ResolveTurnAuthorityInput,
  deps: ResolveTurnAuthorityDeps = {},
): Promise<TurnAuthorityResult> {
  const _isLeadInHandoff = deps.isLeadInHandoff ?? isLeadInHandoff;
  const _resolveConversationTurn = deps.resolveConversationTurn ?? resolveConversationTurn;
  const _findActiveAiNodeSession = deps.findActiveAiNodeSession ?? defaultFindActiveAiNodeSession;
  const isEnabled = deps.isAiNodeEnabled ?? (process.env.FOLLOWUP_AI_NODE_ENABLED === 'true');

  // 1. Humano tem prioridade absoluta: se conversa sob controle humano, IA não responde
  const inHandoff = await _isLeadInHandoff(db, input.tenantId, input.leadId);
  if (inHandoff) {
    return {
      authority: 'human',
      reason: 'lead_in_handoff',
    };
  }

  // 2. Enrollment ativo em Node IA (somente se a feature flag estiver ativa)
  if (isEnabled) {
    const activeNode = await _findActiveAiNodeSession(
      db,
      input.tenantId,
      input.leadId,
      input.conversationId,
    );

    if (activeNode) {
      return {
        authority: 'ai_node',
        enrollment_id: activeNode.enrollment_id,
        flow_id: activeNode.flow_id,
        node_id: activeNode.node_id,
        agent_id: activeNode.session.agent_id ?? null,
        agent_version_id: activeNode.session.agent_version_id ?? null,
        inbound_message_id: input.inboundMessageId ?? null,
        session: activeNode.session,
      };
    }
  }

  // 3, 4, 5. Sem Node IA ativo: delega para o resolver existente (Router, Sessão, Fallback)
  const resolution = await _resolveConversationTurn(
    db,
    llmCfg,
    {
      tenantId: input.tenantId,
      leadId: input.leadId,
      jobId: input.jobId,
      conversationId: input.conversationId,
      channelSessionId: input.channelSessionId,
      inbound: true,
    },
    {
      log: deps.log ?? { info: () => {}, warn: () => {}, error: () => {} },
      loadActiveRouter: deps.loadActiveRouter,
      loadPublishedAgentConfigById: deps.loadPublishedAgentConfigById,
      loadPublishedAgentConfig: deps.loadPublishedAgentConfig,
      classifyIntent: deps.classifyIntent,
    },
  );

  let authority: 'intent_router' | 'session_agent' | 'fallback';

  if (
    resolution.routerId !== null &&
    (resolution.outcome === 'classified' ||
      resolution.outcome === 'sticky' ||
      resolution.outcome === 'reclassified')
  ) {
    authority = 'intent_router';
  } else if (resolution.outcome === 'fallback') {
    authority = 'fallback';
  } else if (resolution.outcome === 'no_router') {
    authority = resolution.config !== null ? 'session_agent' : 'fallback';
  } else {
    // no_match ou classifier_failed que caiu no agente da sessão ou genérico
    authority = resolution.config !== null ? 'session_agent' : 'fallback';
  }

  return {
    authority,
    resolution,
    config: resolution.config,
  };
}

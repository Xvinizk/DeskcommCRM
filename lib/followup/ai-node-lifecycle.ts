/**
 * Ciclo de Vida do Node IA (Fase 4).
 *
 * Responsável por orquestrar ponta a ponta o turno do Node IA:
 * 1. Resolução e validação de graph, enrollment e ai_node_session.
 * 2. Avaliação preliminar de condições determinísticas (deterministic_completed sem LLM e sem envio).
 * 3. Geração e cache estruturado (Structured Output via Zod, reply cache recuperável, zero nova LLM no retry).
 * 4. Fencing e autoridade humana pré-outbound (HUMANO > NODE IA; se humano assumiu durante LLM, aborta envio).
 * 5. Outbound idempotente via sendWithLedger (nunca adapter de canal direto; chave canônica ai_node_send:...).
 * 6. Tratamento de crash recovery antes e depois do outbound (zero reenvio se já aceito; transição retomada com segurança).
 * 7. Decisão semântica estrita:
 *    - continue: envia reply, conclui turno, mantém session running e mesmo node.
 *    - completed: envia reply, conclui turno, transiciona para a aresta completed / avança fluxo.
 *    - handoff: envia reply (se houver), aciona performHumanHandoff, silencia bot, transiciona para aresta handoff ou pausa em paused_handoff.
 * 8. Segurança de extracted_data: uso puramente interno do Node IA, sem mutações livres no CRM.
 * 9. Observabilidade fina com rótulos:
 *    - generated_fresh vs recovered_structured_output
 *    - outbound_fresh vs outbound_already_sent
 *    - transition_fresh vs transition_already_applied
 */
import type pg from 'pg';
import { logger } from '@/lib/logger';
import {
  isLeadInHandoff,
  performHumanHandoff,
} from '@/lib/agent-engine/agent/human-handoff';
import {
  sendWithLedger,
  pgSendLedger,
  type SendOutcome,
} from '@/lib/agent-engine/edge/crm/send-ledger';
import { deterministicUuid } from './engine';
import {
  validateAiNodeTurnOwnership,
  completeAiNodeInboundTurn,
  recordAiNodeReplySent,
  isAiNodeReplyAlreadySent,
  getAiNodeGeneratedReply,
  buildAiNodeTurnCompletedKey,
  type DbPoolLike,
} from './ai-node-idempotency';
import type { AiNodeSession } from './ai-node-session';
import {
  flowGraphSchema,
  aiNodeConfigSchema,
  AI_NODE_COMPLETED_BRANCH_ID,
  AI_NODE_HANDOFF_BRANCH_ID,
  AI_NODE_ERROR_BRANCH_ID,
  type FlowGraph,
  type AiNodeConfig,
  type FlowEdge,
} from './graph-schema';
import {
  executeAiNodeTurn,
  evaluateAiNodeDeterministicConditions,
  type ExecuteAiNodeTurnDeps,
} from './ai-node-executor';
import {
  type AiNodeStructuredOutput,
} from './ai-node-structured-output';

/**
 * Busca estritamente uma aresta de branch para ai_node.
 * NUNCA faz fallback para 'always' ou aresta arbitrária.
 * O modelo/resultado nunca deve provocar avanço por aresta não correspondente.
 */
export function findAiNodeStrictBranchEdge(
  edges: FlowEdge[],
  fromNodeId: string,
  branchId: string,
): FlowEdge | null {
  const candidates = edges
    .filter((e) => e.source === fromNodeId)
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  return (
    candidates.find(
      (e) => e.condition.type === 'branch' && e.condition.branch_id === branchId,
    ) ?? null
  );
}

export interface ExecuteAiNodeLifecycleInput {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
  conversationId?: string | null;
  contactId?: string | null;
  workerId: string;
  leaseGeneration: number;
  inboundText?: string | null;
  graph?: FlowGraph;
  nodeConfig?: AiNodeConfig;
  session?: AiNodeSession;
}

export type AiNodeLifecycleStatus =
  | 'continue'
  | 'completed'
  | 'handoff'
  | 'deterministic_completed'
  | 'aborted_human_takeover'
  | 'stale_lease_owner'
  | 'error';

export interface ExecuteAiNodeLifecycleResult {
  status: AiNodeLifecycleStatus;
  reply?: string;
  structuredOutput?: AiNodeStructuredOutput;
  nextNodeId?: string | null;
  outboundStatus?: 'outbound_fresh' | 'outbound_already_sent' | 'blocked' | 'skipped' | 'failed';
  llmStatus?: 'generated_fresh' | 'recovered_structured_output';
  transitionStatus?: 'transition_fresh' | 'transition_already_applied' | 'skipped';
  reason?: string;
  error?: string;
  isRetry?: boolean;
}

export interface ExecuteAiNodeLifecycleDeps extends ExecuteAiNodeTurnDeps {
  isLeadInHandoffFn?: typeof isLeadInHandoff;
  performHumanHandoffFn?: typeof performHumanHandoff;
  sendWithLedgerFn?: typeof sendWithLedger;
  sendOutboundHandler?: (key: string, messageId: string) => Promise<{ id: string; status: string }>;
  ledgerStore?: Parameters<typeof sendWithLedger>[0];
  clock?: () => Date;
  advanceEnrollmentFn?: (enrollmentId: string, orgId: string, nextNodeId: string) => Promise<void>;
}

/**
 * Constrói a chave de envio canônica baseada no turno para o sendWithLedger.
 */
export function buildAiNodeSendIdempotencyKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_send:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

async function applyAiNodeTransition(
  db: DbPoolLike,
  input: ExecuteAiNodeLifecycleInput,
  nextNodeId: string,
  branchId: string,
  updatedSession: AiNodeSession,
  nowIso: string,
  exitedKey: string,
  deps: ExecuteAiNodeLifecycleDeps | undefined,
  metadata?: Record<string, unknown>,
): Promise<'transition_fresh' | 'transition_already_applied'> {
  const { rows: exitedRows } = await db.query<{ id: string }>(
    `SELECT id FROM followup_enrollment_events WHERE enrollment_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [input.enrollmentId, exitedKey],
  );

  let transitionStatus: 'transition_fresh' | 'transition_already_applied' = 'transition_fresh';

  if (exitedRows.length > 0) {
    transitionStatus = 'transition_already_applied';
    logger.info('[ai-node-lifecycle] Transição já havia sido aplicada anteriormente (zero re-transição)', {
      enrollment_id: input.enrollmentId,
      node_id: input.nodeId,
      branch_id: branchId,
    });
  } else {
    // 1. Atualiza followup_enrollments com status ativo e next_eval_at imediato
    await db.query(
      `UPDATE followup_enrollments
       SET current_node_id = $1, steps_taken = steps_taken + 1, ai_node_session = $2, next_eval_at = $3, status = 'active', claimed_until = null, updated_at = $3
       WHERE organization_id = $4 AND id = $5`,
      [nextNodeId, JSON.stringify(updatedSession), nowIso, input.organizationId, input.enrollmentId],
    );

    // 2. Registra o evento canônico ai_node.exited com chave de idempotência
    await db.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.exited',
        JSON.stringify({
          next_node_id: nextNodeId,
          branch: branchId,
          exited_at: nowIso,
          ...metadata,
        }),
        exitedKey,
        nowIso,
      ],
    );

    // 3. Mecanismo Durável: enfileira job wait_wake na job_queue
    let contactId = input.contactId;
    if (!contactId) {
      try {
        const { rows: cRows } = await db.query<{ contact_id: string }>(
          `SELECT contact_id FROM followup_enrollments WHERE id = $1 LIMIT 1`,
          [input.enrollmentId],
        );
        contactId = cRows[0]?.contact_id;
      } catch {}
    }

    if (contactId) {
      const sourceEventId = deterministicUuid(`followup:${input.enrollmentId}:${exitedKey}`);
      try {
        await db.query(
          `INSERT INTO job_queue (
             organization_id, contact_id, kind, payload, source_event_id, run_after, status
           ) VALUES ($1, $2, 'followup_turn', $3, $4, $5, 'pending')
           ON CONFLICT (organization_id, source_event_id) DO NOTHING`,
          [
            input.organizationId,
            contactId,
            JSON.stringify({
              followup_enrollment_id: input.enrollmentId,
              node_id: nextNodeId,
              purpose: 'wait_wake',
              source_step_key: exitedKey,
            }),
            sourceEventId,
            nowIso,
          ],
        );
      } catch (err) {
        // Mock ou ambiente sem tabela job_queue não quebra a transição
        logger.warn('[ai-node-lifecycle] Não foi possível enfileirar wait_wake durável na job_queue', {
          error: String(err),
        });
      }
    }
  }

  // Continuação crash-safe
  if (deps?.advanceEnrollmentFn) {
    if (transitionStatus === 'transition_fresh') {
      try {
        await deps.advanceEnrollmentFn(input.enrollmentId, input.organizationId, nextNodeId);
      } catch (err) {
        logger.error('[ai-node-lifecycle] Falha ao avançar enrollment pós-transição fresca', {
          enrollment_id: input.enrollmentId,
          next_node_id: nextNodeId,
          branch_id: branchId,
          error: String(err),
        });
      }
    } else {
      // transition_already_applied: recuperação pós-crash
      const { rows: currentEnrRows } = await db.query<{ current_node_id: string; status: string }>(
        `SELECT current_node_id, status FROM followup_enrollments WHERE organization_id = $1 AND id = $2 LIMIT 1`,
        [input.organizationId, input.enrollmentId],
      );
      const currentEnr = currentEnrRows[0];
      if (currentEnr && currentEnr.status === 'active') {
        const resumeNodeId = currentEnr.current_node_id;
        try {
          await deps.advanceEnrollmentFn(input.enrollmentId, input.organizationId, resumeNodeId);
        } catch (err) {
          logger.error('[ai-node-lifecycle] Falha ao recuperar avanço de enrollment pós-crash', {
            enrollment_id: input.enrollmentId,
            resume_node_id: resumeNodeId,
            branch_id: branchId,
            error: String(err),
          });
        }
      }
    }
  }

  return transitionStatus;
}

/**
 * Executa o ciclo de vida completo do Node IA com garantias de segurança e idempotência.
 */
export async function executeAiNodeLifecycle(
  db: DbPoolLike,
  input: ExecuteAiNodeLifecycleInput,
  deps: ExecuteAiNodeLifecycleDeps = {},
): Promise<ExecuteAiNodeLifecycleResult> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();

  // =========================================================================
  // 1. CHECAGEM INICIAL DE IDEMPOTÊNCIA DO TURNO COMPLETO OU TRANSIÇÃO JÁ APLICADA
  // =========================================================================
  const exitedKey = `ai_node_exited:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`;
  const { rows: exitedRows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM followup_enrollment_events
     WHERE enrollment_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [input.enrollmentId, exitedKey],
  );

  const completedKey = buildAiNodeTurnCompletedKey(input);
  const { rows: completedRows } = await db.query<{ id: string }>(
    `SELECT id FROM followup_enrollment_events
     WHERE enrollment_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [input.enrollmentId, completedKey],
  );

  if (exitedRows.length > 0 || completedRows.length > 0) {
    // A transição de saída do Nó IA já ocorreu no passado para esta inbound.
    // Recupera dados estruturados e desfecho gravados.
    const cachedReply = await getAiNodeGeneratedReply(db, input);
    let targetNodeId: string | null = null;
    const payloadRaw = exitedRows[0]?.payload;
    if (payloadRaw) {
      const payloadObj = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw;
      targetNodeId = payloadObj.next_node_id ?? null;
    }

    // Consulta estado atual do enrollment no banco para continuação crash-safe
    const { rows: currentEnrRows } = await db.query<{ current_node_id: string; status: string }>(
      `SELECT current_node_id, status FROM followup_enrollments WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [input.organizationId, input.enrollmentId],
    );
    const currentEnr = currentEnrRows[0];

    // CONTINUAÇÃO CRASH-SAFE:
    // Se o enrollment estiver 'active', retomamos a execução a partir de current_node_id.
    // Se o worker morreu antes de advanceEnrollmentFn, current_node_id === targetNodeId.
    // Se o worker morreu após avançar nós subsequentes, current_node_id estará no nó pendente.
    // Se o enrollment já concluiu (status !== 'active'), NENHUM nó é re-executado (zero duplicação).
    if (deps?.advanceEnrollmentFn && currentEnr && currentEnr.status === 'active') {
      const resumeNodeId = currentEnr.current_node_id;
      try {
        await deps.advanceEnrollmentFn(input.enrollmentId, input.organizationId, resumeNodeId);
      } catch (err) {
        logger.error('[ai-node-lifecycle] Falha ao recuperar avanço pós-crash em retry', {
          enrollment_id: input.enrollmentId,
          resume_node_id: resumeNodeId,
          error: String(err),
        });
      }
    }

    // Se o turno ainda não tiver gravado completedKey, formaliza agora
    if (completedRows.length === 0) {
      await completeAiNodeInboundTurn(db, {
        organizationId: input.organizationId,
        enrollmentId: input.enrollmentId,
        nodeId: input.nodeId,
        inboundMessageId: input.inboundMessageId,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
      });
    }

    return {
      status: cachedReply?.node_status ?? 'completed',
      reply: cachedReply?.reply,
      structuredOutput: cachedReply
        ? {
            reply: cachedReply.reply,
            node_status: cachedReply.node_status,
            outcome: cachedReply.outcome,
            extracted_data: cachedReply.extracted_data,
          }
        : undefined,
      nextNodeId: targetNodeId,
      isRetry: true,
      transitionStatus: 'transition_already_applied',
      outboundStatus: 'outbound_already_sent',
    };
  }

  // =========================================================================
  // 2. CARREGAR CONFIGURAÇÃO, GRAPH E SESSÃO SE NÃO FORNECIDOS
  // =========================================================================
  let nodeConfig = input.nodeConfig;
  let session = input.session;
  let graph = input.graph;
  let contactId = input.contactId ?? null;
  let conversationId = input.conversationId ?? null;
  let stageId: string | null = null;
  let tags: string[] = [];

  if (!nodeConfig || !session || !graph) {
    const { rows: enrRows } = await db.query<{
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
      [input.organizationId, input.enrollmentId],
    );

    const row = enrRows[0];
    if (!row || !row.ai_node_session) {
      return {
        status: 'error',
        error: 'enrollment_or_session_not_found',
      };
    }

    session = session ?? row.ai_node_session;
    contactId = contactId ?? row.contact_id;
    conversationId = conversationId ?? row.conversation_id;

    try {
      graph = graph ?? flowGraphSchema.parse(row.graph);
    } catch {
      return { status: 'error', error: 'invalid_flow_graph' };
    }

    const targetNode = graph.nodes.find((n) => n.id === input.nodeId && n.type === 'ai_node');
    if (!targetNode) {
      return { status: 'error', error: 'node_not_found_in_graph' };
    }

    try {
      nodeConfig = nodeConfig ?? aiNodeConfigSchema.parse(targetNode.config);
    } catch {
      return { status: 'error', error: 'invalid_ai_node_config' };
    }

    // Carrega dados de lead para checagens determinísticas
    try {
      const { rows: leadRows } = await db.query<{ stage_id: string | null; tags: string[] }>(
        `SELECT stage_id, tags FROM crm_leads WHERE organization_id = $1 AND contact_id = $2 ORDER BY updated_at DESC LIMIT 1`,
        [input.organizationId, contactId],
      );
      if (leadRows[0]) {
        stageId = leadRows[0].stage_id;
        tags = leadRows[0].tags ?? [];
      }
    } catch {}
  }

  // =========================================================================
  // 3. AVALIAÇÃO PRELIMINAR DE CONDIÇÕES DETERMINÍSTICAS (deterministic_completed)
  // =========================================================================
  const deterministicEval = evaluateAiNodeDeterministicConditions(
    nodeConfig.deterministic_conditions,
    {
      mediaSummary: session.media_summary,
      tags,
      stageId,
    },
  );

  if (deterministicEval.satisfied) {
    // Condição atendida! ZERO LLM, ZERO mensagem WhatsApp gerada/inventada.
    logger.info('[ai-node-lifecycle] deterministic_completed atendido — avançando sem LLM', {
      enrollment_id: input.enrollmentId,
      node_id: input.nodeId,
      match: deterministicEval.match,
    });

    // Registra ai_node.completed
    await db.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.completed',
        JSON.stringify({
          reason: 'deterministic_completed',
          match: deterministicEval.match,
          completed_at: nowIso,
        }),
        `ai_node_completed_event:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
        nowIso,
      ],
    );

    // Atualiza status da sessão
    const updatedSession: AiNodeSession = {
      ...session,
      status: 'completed',
    };

    // Segue estritamente aresta branch_id=completed do grafo
    const nextEdge = findAiNodeStrictBranchEdge(
      graph.edges,
      input.nodeId,
      AI_NODE_COMPLETED_BRANCH_ID,
    );

    const nextNodeId = nextEdge?.target ?? null;

    if (!nextNodeId) {
      // Regra estrita: se não houver aresta branch_id=completed, NUNCA usar aresta arbitrária!
      return await handleAiNodeError(
        db,
        input,
        graph,
        session,
        'missing_completed_branch: deterministic_completed sem aresta branch_id=completed',
        deps,
      );
    }

    const exitedKey = `ai_node_exited:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`;

    const transitionStatus = await applyAiNodeTransition(
      db,
      input,
      nextNodeId,
      AI_NODE_COMPLETED_BRANCH_ID,
      updatedSession,
      nowIso,
      exitedKey,
      deps,
      { reason: 'deterministic_completed' },
    );

    // Conclui o turno formalmente
    await completeAiNodeInboundTurn(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });

    return {
      status: 'deterministic_completed',
      nextNodeId,
      outboundStatus: 'skipped',
      transitionStatus,
      reason: deterministicEval.match,
    };
  }

  // =========================================================================
  // 4. RECUPERAÇÃO OU GERAÇÃO DO STRUCTURED OUTPUT (Reply Cache)
  // =========================================================================
  let structuredOutput: AiNodeStructuredOutput | null = null;
  let llmStatus: 'generated_fresh' | 'recovered_structured_output' = 'generated_fresh';

  const cachedReply = await getAiNodeGeneratedReply(db, input);
  if (cachedReply) {
    // Cache estruturado recuperado! ZERO nova chamada LLM.
    llmStatus = 'recovered_structured_output';
    structuredOutput = {
      reply: cachedReply.reply,
      node_status: cachedReply.node_status,
      outcome: cachedReply.outcome,
      extracted_data: cachedReply.extracted_data,
    };
    logger.info('[ai-node-lifecycle] Structured Output recuperado do cache com sucesso', {
      enrollment_id: input.enrollmentId,
      node_id: input.nodeId,
      node_status: structuredOutput.node_status,
      llm_status: llmStatus,
    });
  } else {
    // Chamada à LLM via executor com Structured Output obrigatório
    let execRes;
    try {
      execRes = await executeAiNodeTurn(
        db,
        {
          ...input,
          nodeConfig,
          session,
          contactId,
          conversationId,
        },
        deps,
      );
    } catch (err: unknown) {
      return await handleAiNodeError(
        db,
        input,
        graph,
        session,
        err instanceof Error ? err.message : String(err),
        deps,
      );
    }

    if (execRes.status === 'stale_lease_owner') {
      return { status: 'stale_lease_owner', reason: execRes.reason };
    }

    if (execRes.status === 'agent_unavailable' || execRes.status === 'error') {
      // Trata erro de agente ou provider -> avança branch error se existir
      return await handleAiNodeError(db, input, graph, session, execRes.reason ?? 'agent_or_provider_error', deps);
    }

    if (execRes.status === 'generated' && execRes.structuredOutput) {
      structuredOutput = execRes.structuredOutput;
    }

    if (!structuredOutput) {
      // Falha de parser ou schema inválido -> Runtime Error (zero envio ao cliente, branch error)
      return await handleAiNodeError(db, input, graph, session, 'invalid_structured_output', deps);
    }

    llmStatus = 'generated_fresh';
  }

  // =========================================================================
  // 5. AUTORIDADE HUMANA PRÉ-OUTBOUND (HUMANO > NODE IA)
  // =========================================================================
  const checkHumanTakeover = deps.isLeadInHandoffFn ?? isLeadInHandoff;
  if (contactId) {
    const isHumanActive = await checkHumanTakeover(
      db as unknown as pg.Pool,
      input.organizationId,
      contactId,
    );

    if (isHumanActive) {
      // O atendente humano assumiu o comando enquanto a LLM processava!
      // Invariante de autoridade: HUMANO > NODE IA. O Node IA NÃO envia nada!
      logger.warn('[ai-node-lifecycle] Envio cancelado: atendente humano assumiu o comando (HUMANO > IA)', {
        enrollment_id: input.enrollmentId,
        node_id: input.nodeId,
        contact_id: contactId,
      });

      await db.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          'ai_node.aborted_human_takeover',
          JSON.stringify({
            inbound_message_id: input.inboundMessageId,
            aborted_at: nowIso,
            reason: 'human_takeover_detected_before_outbound',
          }),
          `ai_node_takeover:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
          nowIso,
        ],
      );

      // Pausa o enrollment sem avançar o nó (HUMANO > IA)
      await db.query(
        `UPDATE followup_enrollments
         SET status = 'paused_handoff', updated_at = $1
         WHERE organization_id = $2 AND id = $3`,
        [nowIso, input.organizationId, input.enrollmentId],
      );

      // Conclui turno para liberar active_turn
      await completeAiNodeInboundTurn(db, {
        organizationId: input.organizationId,
        enrollmentId: input.enrollmentId,
        nodeId: input.nodeId,
        inboundMessageId: input.inboundMessageId,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
      });

      return {
        status: 'aborted_human_takeover',
        structuredOutput,
        reply: structuredOutput.reply,
        outboundStatus: 'skipped',
        llmStatus,
        transitionStatus: 'skipped',
        reason: 'human_takeover_pre_outbound',
      };
    }
  }

  // =========================================================================
  // 6. FENCING IMEDIATAMENTE ANTES DO ENVIO
  // =========================================================================
  const ownershipValidation = await validateAiNodeTurnOwnership(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
    workerId: input.workerId,
    leaseGeneration: input.leaseGeneration,
  });

  if (!ownershipValidation.is_valid) {
    logger.warn('[ai-node-lifecycle] Fencing rejeitado pré-outbound: worker perdeu lease', {
      enrollment_id: input.enrollmentId,
      node_id: input.nodeId,
      reason: ownershipValidation.reason,
    });
    return {
      status: 'stale_lease_owner',
      reason: ownershipValidation.reason ?? 'stale_owner_before_outbound',
    };
  }

  // Confirma current_node_id e status da sessão
  const { rows: enrCheckRows } = await db.query<{
    current_node_id: string;
    ai_node_session: AiNodeSession | null;
  }>(
    `SELECT current_node_id, ai_node_session FROM followup_enrollments WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.enrollmentId],
  );

  const currentEnr = enrCheckRows[0];
  if (!currentEnr || currentEnr.current_node_id !== input.nodeId || currentEnr.ai_node_session?.status !== 'running') {
    return {
      status: 'stale_lease_owner',
      reason: 'node_or_session_not_running',
    };
  }

  // =========================================================================
  // 7. OUTBOUND VIA sendWithLedger
  // =========================================================================
  let outboundStatus: 'outbound_fresh' | 'outbound_already_sent' | 'blocked' | 'skipped' | 'failed' = 'outbound_fresh';
  let crmMessageId: string | null = null;

  // Verifica se o outbound já foi aceito anteriormente (crash recovery)
  const alreadySentCheck = await isAiNodeReplyAlreadySent(db, {
    organizationId: input.organizationId,
    enrollmentId: input.enrollmentId,
    nodeId: input.nodeId,
    inboundMessageId: input.inboundMessageId,
  });

  if (alreadySentCheck.alreadySent) {
    outboundStatus = 'outbound_already_sent';
    crmMessageId = alreadySentCheck.crmMessageId ?? null;
    logger.info('[ai-node-lifecycle] Outbound já havia sido aceito anteriormente (zero reenvio)', {
      enrollment_id: input.enrollmentId,
      node_id: input.nodeId,
      inbound_message_id: input.inboundMessageId,
    });
  } else {
    // Envio canônico com sendWithLedger
    const sendKey = buildAiNodeSendIdempotencyKey(input);
    const intentJobId = deterministicUuid(sendKey);
    const store = deps.ledgerStore ?? pgSendLedger(db as unknown as Parameters<typeof pgSendLedger>[0]);
    const sendFn = deps.sendOutboundHandler ?? (async (key: string, id: string) => {
      return { id, status: 'sent' };
    });

    const sendCaller = deps.sendWithLedgerFn ?? sendWithLedger;

    let sendOutcome: SendOutcome;
    try {
      sendOutcome = await sendCaller(
        store,
        {
          tenantId: input.organizationId,
          leadId: contactId,
          jobId: intentJobId,
          seq: 1,
          body: structuredOutput.reply,
        },
        sendFn,
      );
    } catch (err) {
      logger.error('[ai-node-lifecycle] Falha técnica no sendWithLedger', { error: String(err) });
      return await handleAiNodeError(db, input, graph, session, 'send_with_ledger_exception', deps);
    }

    if (sendOutcome.kind === 'sent') {
      outboundStatus = 'outbound_fresh';
      crmMessageId = sendOutcome.crmMessageId;
    } else if (sendOutcome.kind === 'already_sent') {
      outboundStatus = 'outbound_already_sent';
      crmMessageId = sendOutcome.crmMessageId;
    } else if (sendOutcome.kind === 'blocked') {
      outboundStatus = 'blocked';
    } else {
      outboundStatus = 'failed';
      return await handleAiNodeError(db, input, graph, session, `send_failed_${sendOutcome.kind}`, deps);
    }

    // Persiste evento ai_node.reply_sent
    await recordAiNodeReplySent(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      crmMessageId,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });
  }

  // =========================================================================
  // 7.1. CHECAGEM DE HUMANO APÓS OUTBOUND E ANTES DA TRANSIÇÃO (HUMANO > IA)
  // =========================================================================
  if (contactId && structuredOutput.node_status !== 'handoff') {
    const isHumanActivePostSend = await checkHumanTakeover(
      db as unknown as pg.Pool,
      input.organizationId,
      contactId,
    );

    if (isHumanActivePostSend) {
      logger.warn('[ai-node-lifecycle] Humano assumiu após outbound aceito e antes da transição (HUMANO > IA)', {
        enrollment_id: input.enrollmentId,
        node_id: input.nodeId,
        contact_id: contactId,
      });

      await db.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          'ai_node.human_takeover_pre_transition',
          JSON.stringify({
            inbound_message_id: input.inboundMessageId,
            detected_at: nowIso,
            reason: 'human_takeover_detected_after_outbound_before_transition',
          }),
          `ai_node_human_pre_trans:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
          nowIso,
        ],
      );

      // Pausa o enrollment sem avançar o nó nem alterar etapas do lead
      await db.query(
        `UPDATE followup_enrollments
         SET status = 'paused_handoff', updated_at = $1
         WHERE organization_id = $2 AND id = $3`,
        [nowIso, input.organizationId, input.enrollmentId],
      );

      // Conclui o turno liberando active_turn
      await completeAiNodeInboundTurn(db, {
        organizationId: input.organizationId,
        enrollmentId: input.enrollmentId,
        nodeId: input.nodeId,
        inboundMessageId: input.inboundMessageId,
        outboundMessageId: crmMessageId ?? undefined,
        workerId: input.workerId,
        leaseGeneration: input.leaseGeneration,
      });

      return {
        status: 'aborted_human_takeover',
        reply: structuredOutput.reply,
        structuredOutput,
        outboundStatus,
        llmStatus,
        transitionStatus: 'skipped',
        reason: 'human_takeover_before_transition',
      };
    }
  }

  // =========================================================================
  // 8. TRANSIÇÃO DE ESTADO E NÓ NO ENROLLMENT (continue, completed, handoff)
  // =========================================================================
  const nodeStatus = structuredOutput.node_status;

  // Atualiza extracted_data internamente na sessão sem tocar no CRM
  const currentExtracted = (session.extracted_data as Record<string, unknown> | undefined) ?? {};
  const mergedExtracted = {
    ...currentExtracted,
    ...structuredOutput.extracted_data,
  };

  // CASO 8.1: STATUS CONTINUE
  if (nodeStatus === 'continue') {
    const updatedSession: AiNodeSession = {
      ...session,
      extracted_data: mergedExtracted,
      status: 'running',
    };

    // Registra ai_node.continue
    await db.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.continue',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          extracted_data: structuredOutput.extracted_data,
          continued_at: nowIso,
        }),
        `ai_node_continue:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
        nowIso,
      ],
    );

    // Atualiza enrollment mantendo no mesmo node
    await db.query(
      `UPDATE followup_enrollments
       SET ai_node_session = $1, updated_at = $2
       WHERE organization_id = $3 AND id = $4`,
      [JSON.stringify(updatedSession), nowIso, input.organizationId, input.enrollmentId],
    );

    // Conclui o turno atual liberando active_turn
    await completeAiNodeInboundTurn(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      outboundMessageId: crmMessageId ?? undefined,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });

    return {
      status: 'continue',
      reply: structuredOutput.reply,
      structuredOutput,
      nextNodeId: input.nodeId,
      outboundStatus,
      llmStatus,
      transitionStatus: 'transition_fresh',
    };
  }

  // CASO 8.2: STATUS COMPLETED
  if (nodeStatus === 'completed') {
    const updatedSession: AiNodeSession = {
      ...session,
      extracted_data: mergedExtracted,
      status: 'completed',
    };

    // Registra ai_node.completed
    await db.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.completed',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          outcome: structuredOutput.outcome,
          extracted_data: structuredOutput.extracted_data,
          completed_at: nowIso,
        }),
        `ai_node_completed_event:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
        nowIso,
      ],
    );

    // Segue estritamente aresta branch_id=completed do grafo
    const nextEdge = findAiNodeStrictBranchEdge(
      graph.edges,
      input.nodeId,
      AI_NODE_COMPLETED_BRANCH_ID,
    );

    const nextNodeId = nextEdge?.target ?? null;

    if (!nextNodeId) {
      // Regra estrita: se não houver aresta branch_id=completed, NUNCA usar aresta arbitrária!
      return await handleAiNodeError(
        db,
        input,
        graph,
        session,
        'missing_completed_branch: node_status=completed mas nenhuma aresta branch_id=completed foi configurada',
        deps,
      );
    }

    const exitedKey = `ai_node_exited:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`;

    const transitionStatus = await applyAiNodeTransition(
      db,
      input,
      nextNodeId,
      AI_NODE_COMPLETED_BRANCH_ID,
      updatedSession,
      nowIso,
      exitedKey,
      deps,
      { outcome: structuredOutput.outcome },
    );

    // Conclui o turno
    await completeAiNodeInboundTurn(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      outboundMessageId: crmMessageId ?? undefined,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });

    return {
      status: 'completed',
      reply: structuredOutput.reply,
      structuredOutput,
      nextNodeId,
      outboundStatus,
      llmStatus,
      transitionStatus,
    };
  }

  // CASO 8.3: STATUS HANDOFF
  if (nodeStatus === 'handoff') {
    const updatedSession: AiNodeSession = {
      ...session,
      extracted_data: mergedExtracted,
      status: 'handoff',
    };

    // Registra ai_node.handoff
    await db.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.handoff',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          outcome: structuredOutput.outcome,
          handoff_at: nowIso,
        }),
        `ai_node_handoff_event:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
        nowIso,
      ],
    );

    // Aciona o mecanismo canônico de handoff humano
    if (contactId && conversationId) {
      const doHandoff = deps.performHumanHandoffFn ?? performHumanHandoff;
      try {
        await doHandoff(
          db as unknown as pg.Pool,
          {
            tenantId: input.organizationId,
            leadId: contactId,
            conversationId,
          },
          {
            reason: structuredOutput.outcome ?? 'ai_node_requested_handoff',
            conversationSummary: `Transbordo acionado pelo Node IA "${input.nodeId}"`,
            log: deps.log ?? logger,
          },
        );
      } catch (err) {
        logger.error('[ai-node-lifecycle] Falha ao executar performHumanHandoff', { error: String(err) });
      }
    }

    // Procura aresta de handoff
    const handoffEdge = findAiNodeStrictBranchEdge(
      graph.edges,
      input.nodeId,
      AI_NODE_HANDOFF_BRANCH_ID,
    );

    const nextNodeId = handoffEdge?.target ?? null;

    let transitionStatus: 'transition_fresh' | 'transition_already_applied' = 'transition_fresh';

    if (nextNodeId) {
      const exitedKey = `ai_node_exited:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`;
      transitionStatus = await applyAiNodeTransition(
        db,
        input,
        nextNodeId,
        AI_NODE_HANDOFF_BRANCH_ID,
        updatedSession,
        nowIso,
        exitedKey,
        deps,
      );
    } else {
      // Pausa o enrollment na fila humana
      await db.query(
        `UPDATE followup_enrollments
         SET status = 'paused_handoff', outcome = 'handoff', ai_node_session = $1, next_eval_at = null, claimed_until = null, updated_at = $2
         WHERE organization_id = $3 AND id = $4`,
        [JSON.stringify(updatedSession), nowIso, input.organizationId, input.enrollmentId],
      );
    }

    // Conclui o turno
    await completeAiNodeInboundTurn(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      outboundMessageId: crmMessageId ?? undefined,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });

    return {
      status: 'handoff',
      reply: structuredOutput.reply,
      structuredOutput,
      nextNodeId,
      outboundStatus,
      llmStatus,
      transitionStatus,
    };
  }

  return { status: 'error', error: 'unrecognized_node_status' };
}

/**
 * Trata erros de execução (provider, agente indisponível, parser).
 * Se o nó possuir branch "error", avança por ela; senão, fail-closed seguro com log.
 */
async function handleAiNodeError(
  db: DbPoolLike,
  input: ExecuteAiNodeLifecycleInput,
  graph: FlowGraph,
  session: AiNodeSession,
  reason: string,
  deps?: ExecuteAiNodeLifecycleDeps,
): Promise<ExecuteAiNodeLifecycleResult> {
  const nowIso = new Date().toISOString();

  // Registra evento ai_node.error
  await db.query(
    `INSERT INTO followup_enrollment_events (
       organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.enrollmentId,
      input.nodeId,
      'ai_node.error',
      JSON.stringify({
        inbound_message_id: input.inboundMessageId,
        reason,
        occurred_at: nowIso,
      }),
      `ai_node_error:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`,
      nowIso,
    ],
  );

  const errorEdge = findAiNodeStrictBranchEdge(
    graph.edges,
    input.nodeId,
    AI_NODE_ERROR_BRANCH_ID,
  );

  const nextNodeId = errorEdge?.target ?? null;

  let transitionStatus: 'transition_fresh' | 'transition_already_applied' = 'transition_fresh';

  if (nextNodeId) {
    const updatedSession: AiNodeSession = {
      ...session,
      status: 'completed',
    };
    const exitedKey = `ai_node_exited:${input.organizationId}:${input.enrollmentId}:${input.nodeId}:${input.inboundMessageId}`;
    transitionStatus = await applyAiNodeTransition(
      db,
      input,
      nextNodeId,
      AI_NODE_ERROR_BRANCH_ID,
      updatedSession,
      nowIso,
      exitedKey,
      deps,
      { reason },
    );
  } else {
    // Fail-closed seguro: marca erro na sessão sem avançar
    const errorSession: AiNodeSession = {
      ...session,
      status: 'error',
    };
    await db.query(
      `UPDATE followup_enrollments
       SET ai_node_session = $1, updated_at = $2
       WHERE organization_id = $3 AND id = $4`,
      [JSON.stringify(errorSession), nowIso, input.organizationId, input.enrollmentId],
    );
  }

  // Conclui turno para não travar workers
  try {
    await completeAiNodeInboundTurn(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });
  } catch {}

  return {
    status: 'error',
    reason,
    nextNodeId,
    outboundStatus: 'skipped',
    transitionStatus,
  };
}

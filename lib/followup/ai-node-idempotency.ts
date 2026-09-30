import type pg from 'pg';
import type { AiNodeSession } from './ai-node-session';
import { fetchAndAggregateAiNodeMedia } from './ai-node-media';

export interface QueryableClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface DbPoolLike extends QueryableClient {
  connect?(): Promise<QueryableClient & { release(): void }>;
}

export interface AcquireAiNodeInboundTurnInput {
  organizationId: string;
  enrollmentId: string;
  expectedNodeId: string;
  inboundMessageId: string;
  conversationId?: string | null;
  messageSentAt?: string | Date | null;
}

export type AcquireAiNodeTurnResult =
  | {
      status: 'acquired';
      is_retry: false;
      enrollment_id: string;
      node_id: string;
      agent_id: string | null;
      agent_version_id: string | null;
      inbound_message_id: string;
      turn_count: number;
      session: AiNodeSession;
    }
  | {
      /**
       * Claim já existia no banco mas o turno não havia sido concluído.
       * Ocorre em crash/restart do worker: o retry DEVE retomar a execução
       * sem incrementar turn_count novamente.
       */
      status: 'resumed';
      is_retry: true;
      enrollment_id: string;
      node_id: string;
      agent_id: string | null;
      agent_version_id: string | null;
      inbound_message_id: string;
      turn_count: number;
      session: AiNodeSession;
    }
  | {
      /**
       * O turno para esta mensagem já foi completamente processado e concluído.
       * Retry é no-op seguro.
       */
      status: 'completed';
      is_retry: true;
      enrollment_id: string;
      node_id: string;
      inbound_message_id: string;
    }
  | {
      status: 'node_changed';
      enrollment_id: string;
      currentNodeId: string;
      expectedNodeId: string;
    }
  | {
      status: 'session_not_running';
      enrollment_id: string;
      sessionStatus?: string;
    }
  | {
      status: 'not_found_or_inactive';
      enrollment_id: string;
    };

export interface AcquireAiNodeInboundTurnDeps {
  clock?: () => Date;
  fetchMediaSummary?: typeof fetchAndAggregateAiNodeMedia;
}

/**
 * Constrói a chave canônica para claim de turno inbound no Node IA.
 */
export function buildAiNodeTurnClaimKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_claim:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

/**
 * Constrói a chave canônica para turno concluído no Node IA.
 */
export function buildAiNodeTurnCompletedKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_completed:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

/**
 * Constrói a chave canônica para resposta gerada de LLM (idempotência de custo).
 */
export function buildAiNodeReplyKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_reply:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

/**
 * Mantido para compatibilidade retroativa. Aponta para o claim.
 */
export function buildAiNodeTurnIdempotencyKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return buildAiNodeTurnClaimKey(params);
}

/**
 * Adquire a idempotência com separação estrita entre CLAIM e CONCLUSÃO.
 *
 * Garante:
 * 1. Lock CAS via SELECT ... FOR UPDATE no enrollment.
 * 2. Se o nó já mudou (timeout correu antes), desiste sem incrementar turn_count (Cenário B).
 * 3. Se o turno já foi concluído (evento ai_node.turn_completed), retorna 'completed' (no-op seguro).
 * 4. Se o claim já existe mas não foi concluído (worker crashou), retorna 'resumed' (retomada pós-crash,
 *    SEM incrementar turn_count novamente).
 * 5. Se claim inédito, incrementa turn_count exatamente 1 vez e grava o claim.
 * 6. Atualiza last_inbound_at de forma estritamente MONOTÔNICA (nunca regride com mensagem atrasada/retry).
 * 7. Atualiza media_summary determinístico.
 * 8. Emite eventos auditáveis do ciclo de vida: ai_node.inbound_received e ai_node.turn_started.
 */
export async function acquireAiNodeInboundTurn(
  db: DbPoolLike,
  input: AcquireAiNodeInboundTurnInput,
  deps: AcquireAiNodeInboundTurnDeps = {},
): Promise<AcquireAiNodeTurnResult> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    // 1. Lock e validação de estado do enrollment (Cenário A vs Cenário B)
    const { rows } = await client.query<{
      id: string;
      current_node_id: string;
      status: string;
      ai_node_session: AiNodeSession | null;
      conversation_id: string | null;
    }>(
      `SELECT id, current_node_id, status, ai_node_session, conversation_id
       FROM followup_enrollments
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [input.organizationId, input.enrollmentId],
    );

    const enrollment = rows[0];
    if (!enrollment || (enrollment.status !== 'active' && enrollment.status !== 'waiting_reply')) {
      await client.query('ROLLBACK');
      return { status: 'not_found_or_inactive', enrollment_id: input.enrollmentId };
    }

    // Cenário B: Timeout/transição já mudou current_node_id antes do lock
    if (enrollment.current_node_id !== input.expectedNodeId) {
      await client.query('ROLLBACK');
      return {
        status: 'node_changed',
        enrollment_id: enrollment.id,
        currentNodeId: enrollment.current_node_id,
        expectedNodeId: input.expectedNodeId,
      };
    }

    const session = enrollment.ai_node_session;
    if (!session || session.status !== 'running' || session.node_id !== input.expectedNodeId) {
      await client.query('ROLLBACK');
      return {
        status: 'session_not_running',
        enrollment_id: enrollment.id,
        sessionStatus: session?.status,
      };
    }

    const claimKey = buildAiNodeTurnClaimKey({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      nodeId: input.expectedNodeId,
      inboundMessageId: input.inboundMessageId,
    });

    const completedKey = buildAiNodeTurnCompletedKey({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      nodeId: input.expectedNodeId,
      inboundMessageId: input.inboundMessageId,
    });

    // 2. CASO B: Verificar se este turno já foi COMPLETAMENTE concluído
    const { rows: completedRows } = await client.query<{ id: string }>(
      `SELECT id FROM followup_enrollment_events
       WHERE enrollment_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [enrollment.id, completedKey],
    );

    if (completedRows.length > 0) {
      await client.query('ROLLBACK');
      return {
        status: 'completed',
        is_retry: true,
        enrollment_id: enrollment.id,
        node_id: input.expectedNodeId,
        inbound_message_id: input.inboundMessageId,
      };
    }

    // 3. CASO C: Verificar se já existe CLAIM em voo / pós-crash (Recoverability)
    const { rows: claimRows } = await client.query<{ id: string }>(
      `SELECT id FROM followup_enrollment_events
       WHERE enrollment_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [enrollment.id, claimKey],
    );

    if (claimRows.length > 0) {
      // O worker anterior adquiriu claim mas caiu antes de completar.
      // RETOMAR A EXECUÇÃO sem incrementar turn_count novamente!
      await client.query('COMMIT');
      return {
        status: 'resumed',
        is_retry: true,
        enrollment_id: enrollment.id,
        node_id: input.expectedNodeId,
        agent_id: session.agent_id ?? null,
        agent_version_id: session.agent_version_id ?? null,
        inbound_message_id: input.inboundMessageId,
        turn_count: session.turn_count ?? 1,
        session,
      };
    }

    // 4. CASO A: Mensagem inédita → Adquirir claim
    const inboundEventInsert = await client.query<{ id: string }>(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.organizationId,
        enrollment.id,
        input.expectedNodeId,
        'ai_node.inbound_received',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          received_at: nowIso,
        }),
        claimKey,
        nowIso,
      ],
    );

    // Corrida simultânea onde outra thread inseriu exatamente agora
    if (inboundEventInsert.rows.length === 0) {
      await client.query('COMMIT');
      return {
        status: 'resumed',
        is_retry: true,
        enrollment_id: enrollment.id,
        node_id: input.expectedNodeId,
        agent_id: session.agent_id ?? null,
        agent_version_id: session.agent_version_id ?? null,
        inbound_message_id: input.inboundMessageId,
        turn_count: session.turn_count ?? 1,
        session,
      };
    }

    // 5. Mutação atômica do session (turn_count, last_inbound_at monotônico, media_summary)
    const turnCount = (session.turn_count ?? 0) + 1;

    // MONOTONICIDADE de last_inbound_at: GREATEST(last_inbound_at, incoming_sent_at)
    const incomingTimeMs = input.messageSentAt
      ? new Date(input.messageSentAt).getTime()
      : now.getTime();
    const existingTimeMs = session.last_inbound_at
      ? new Date(session.last_inbound_at).getTime()
      : 0;
    const monotonicTimeMs = Math.max(isNaN(existingTimeMs) ? 0 : existingTimeMs, isNaN(incomingTimeMs) ? now.getTime() : incomingTimeMs);
    const lastInboundAt = new Date(monotonicTimeMs).toISOString();

    let mediaSummary = session.media_summary;
    const conversationId = input.conversationId ?? enrollment.conversation_id;
    if (conversationId) {
      try {
        const fetchMedia = deps.fetchMediaSummary ?? fetchAndAggregateAiNodeMedia;
        mediaSummary = await fetchMedia(
          client as unknown as pg.Pool,
          input.organizationId,
          conversationId,
          session.started_at,
        );
      } catch {
        // Se a leitura de mídias falhar ou não estiver disponível, mantém o resumo existente
      }
    }

    const updatedSession: AiNodeSession = {
      ...session,
      turn_count: turnCount,
      last_inbound_at: lastInboundAt,
      media_summary: mediaSummary ?? {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    await client.query(
      `UPDATE followup_enrollments
       SET ai_node_session = $1, updated_at = $2
       WHERE organization_id = $3 AND id = $4`,
      [JSON.stringify(updatedSession), nowIso, input.organizationId, enrollment.id],
    );

    // 6. Emite evento permitido: ai_node.turn_started
    const turnStartedKey = `ai_node_turn_started:${input.organizationId}:${enrollment.id}:${input.expectedNodeId}:${input.inboundMessageId}`;
    await client.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING`,
      [
        input.organizationId,
        enrollment.id,
        input.expectedNodeId,
        'ai_node.turn_started',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          turn_count: turnCount,
          started_at: nowIso,
        }),
        turnStartedKey,
        nowIso,
      ],
    );

    await client.query('COMMIT');

    return {
      status: 'acquired',
      is_retry: false,
      enrollment_id: enrollment.id,
      node_id: input.expectedNodeId,
      agent_id: session.agent_id ?? null,
      agent_version_id: session.agent_version_id ?? null,
      inbound_message_id: input.inboundMessageId,
      turn_count: turnCount,
      session: updatedSession,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignora erro no rollback
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * Conclui formalmente o turno do Node IA.
 * Deve ser chamado ao final do turno (após resposta/outbound ou handoff).
 * Uma vez concluído, retries subsequentes recebem 'completed' (no-op seguro).
 */
export async function completeAiNodeInboundTurn(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
    outboundMessageId?: string | null;
  },
  deps: { clock?: () => Date } = {},
): Promise<{ status: 'completed'; event_id?: string }> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const completedKey = buildAiNodeTurnCompletedKey(input);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO followup_enrollment_events (
       organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (enrollment_id, idempotency_key) DO UPDATE
       SET payload = followup_enrollment_events.payload
     RETURNING id`,
    [
      input.organizationId,
      input.enrollmentId,
      input.nodeId,
      'ai_node.turn_completed',
      JSON.stringify({
        inbound_message_id: input.inboundMessageId,
        outbound_message_id: input.outboundMessageId ?? null,
        completed_at: nowIso,
      }),
      completedKey,
      nowIso,
    ],
  );

  return { status: 'completed', event_id: rows[0]?.id };
}

/**
 * Registra resposta de LLM gerada para evitar custo duplicado de modelo
 * em caso de crash pós-LLM e pré-outbound. (Preparado para Fase 3).
 */
export async function recordAiNodeReplyGenerated(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
    replyText: string;
    tokensIn?: number;
    tokensOut?: number;
  },
  deps: { clock?: () => Date } = {},
): Promise<{ recorded: boolean }> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const replyKey = buildAiNodeReplyKey(input);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO followup_enrollment_events (
       organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (enrollment_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.organizationId,
      input.enrollmentId,
      input.nodeId,
      'ai_node.reply_generated',
      JSON.stringify({
        inbound_message_id: input.inboundMessageId,
        reply_text: input.replyText,
        tokens_in: input.tokensIn ?? 0,
        tokens_out: input.tokensOut ?? 0,
        generated_at: nowIso,
      }),
      replyKey,
      nowIso,
    ],
  );

  return { recorded: rows.length > 0 };
}

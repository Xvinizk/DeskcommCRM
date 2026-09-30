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
  /** Identificador do worker executante (ex.: job_queue.locked_by ou caller uuid) */
  workerId?: string;
  /** Duração da lease em milissegundos (default: 60_000ms = 60s) */
  leaseDurationMs?: number;
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
      lease_until: string;
      worker_id: string;
    }
  | {
      /**
       * Takeover de claim expirado (crash do worker anterior após lease timeout).
       * Este worker assumiu atomicamente a titularidade da execução.
       * O retry DEVE retomar a execução SEM incrementar turn_count.
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
      lease_until: string;
      worker_id: string;
    }
  | {
      /**
       * Claim existente e AINDA ATIVO (outro worker está processando ou dentro da lease).
       * NÃO processar nem chamar LLM!
       */
      status: 'in_progress';
      is_retry: true;
      enrollment_id: string;
      node_id: string;
      inbound_message_id: string;
      worker_id?: string;
      lease_until?: string;
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
 * Adquire o claim de execução para um turno inbound no Node IA com lease e isolamento.
 *
 * Estados possíveis:
 * 1. 'acquired'   -> Claim inédito adquirido por este worker. Pode processar.
 * 2. 'in_progress'-> Claim ativo pertencente a outro worker (ou em voo). Não processar.
 * 3. 'resumed'    -> Claim expirou (worker crashou) e este worker assumiu takeover atômico. Pode retomar.
 * 4. 'completed'  -> Turno já foi completamente concluído anteriormente. No-op seguro.
 *
 * Garante:
 * - Mutex CAS via SELECT ... FOR UPDATE no enrollment.
 * - Takeover atômico transacional: 20 workers simultâneos sobre claim expirado resultam em exatamente 1 resumed.
 * - Monotonicidade estrita de last_inbound_at.
 * - turn_count NÃO é duplicado em takeover/resumed.
 */
export async function acquireAiNodeInboundTurn(
  db: DbPoolLike,
  input: AcquireAiNodeInboundTurnInput,
  deps: AcquireAiNodeInboundTurnDeps = {},
): Promise<AcquireAiNodeTurnResult> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  const workerId = input.workerId ?? ('worker-' + Math.random().toString(36).slice(2, 10));
  const leaseUntilIso = new Date(now.getTime() + leaseDurationMs).toISOString();

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    // 1. Lock e validação de estado do enrollment
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

    // 2. CASO D / E: Verificar se este turno já foi COMPLETAMENTE concluído
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

    // 3. Verificar se já existe CLAIM (em voo ou expirado)
    const { rows: claimRows } = await client.query<{
      id: string;
      payload: Record<string, unknown> | string | null;
      created_at: string;
    }>(
      `SELECT id, payload, created_at FROM followup_enrollment_events
       WHERE enrollment_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [enrollment.id, claimKey],
    );

    const hasClaim = claimRows.length > 0 || session.active_turn?.inbound_message_id === input.inboundMessageId;

    if (hasClaim) {
      const claimPayload = claimRows[0]?.payload
        ? (typeof claimRows[0].payload === 'string'
            ? JSON.parse(claimRows[0].payload)
            : claimRows[0].payload)
        : null;

      const activeLeaseUntilStr = session.active_turn?.lease_until ?? claimPayload?.lease_until;
      const activeWorkerId = session.active_turn?.worker_id ?? claimPayload?.worker_id;
      const attempts = session.active_turn?.attempts ?? claimPayload?.attempts ?? 1;

      const leaseUntilMs = activeLeaseUntilStr ? new Date(activeLeaseUntilStr).getTime() : 0;
      const nowMs = now.getTime();

      // CASO B: Claim existe e AINDA É VÁLIDO / ATIVO (outro worker trabalhando ou entrega concorrente)
      if (activeLeaseUntilStr && nowMs < leaseUntilMs) {
        await client.query('ROLLBACK');
        return {
          status: 'in_progress',
          is_retry: true,
          enrollment_id: enrollment.id,
          node_id: input.expectedNodeId,
          inbound_message_id: input.inboundMessageId,
          worker_id: activeWorkerId,
          lease_until: activeLeaseUntilStr,
        };
      }

      // CASO C: Claim existe mas a LEASE EXPIROU (worker anterior crashou ou abandonou)
      // Executa TAKEOVER ATÔMICO com renovação de lease e incremento de attempts.
      // turn_count NÃO é incrementado novamente!
      const updatedSession: AiNodeSession = {
        ...session,
        active_turn: {
          inbound_message_id: input.inboundMessageId,
          worker_id: workerId,
          claimed_at: nowIso,
          lease_until: leaseUntilIso,
          attempts: attempts + 1,
        },
      };

      await client.query(
        `UPDATE followup_enrollments
         SET ai_node_session = $1, updated_at = $2
         WHERE organization_id = $3 AND id = $4`,
        [JSON.stringify(updatedSession), nowIso, input.organizationId, enrollment.id],
      );

      // Atualiza o evento de claim existente
      await client.query(
        `UPDATE followup_enrollment_events
         SET payload = $1
         WHERE enrollment_id = $2 AND idempotency_key = $3`,
        [
          JSON.stringify({
            inbound_message_id: input.inboundMessageId,
            received_at: claimPayload?.received_at ?? nowIso,
            worker_id: workerId,
            claimed_at: nowIso,
            lease_until: leaseUntilIso,
            attempts: attempts + 1,
          }),
          enrollment.id,
          claimKey,
        ],
      );

      // Registra evento de auditoria de takeover
      await client.query(
        `INSERT INTO followup_enrollment_events (
           organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.organizationId,
          enrollment.id,
          input.expectedNodeId,
          'ai_node.claim_takeover',
          JSON.stringify({
            inbound_message_id: input.inboundMessageId,
            previous_worker_id: activeWorkerId,
            new_worker_id: workerId,
            previous_lease_until: activeLeaseUntilStr,
            new_lease_until: leaseUntilIso,
            takeover_at: nowIso,
            attempts: attempts + 1,
          }),
          null,
          nowIso,
        ],
      );

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
        session: updatedSession,
        lease_until: leaseUntilIso,
        worker_id: workerId,
      };
    }

    // 4. CASO A: Mensagem inédita → Adquirir claim inicial
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
          worker_id: workerId,
          claimed_at: nowIso,
          lease_until: leaseUntilIso,
          attempts: 1,
        }),
        claimKey,
        nowIso,
      ],
    );

    // Corrida atômica onde outra thread inseriu exatamente agora
    if (inboundEventInsert.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        status: 'in_progress',
        is_retry: true,
        enrollment_id: enrollment.id,
        node_id: input.expectedNodeId,
        inbound_message_id: input.inboundMessageId,
        worker_id: workerId,
        lease_until: leaseUntilIso,
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
    const monotonicTimeMs = Math.max(
      isNaN(existingTimeMs) ? 0 : existingTimeMs,
      isNaN(incomingTimeMs) ? now.getTime() : incomingTimeMs,
    );
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
      active_turn: {
        inbound_message_id: input.inboundMessageId,
        worker_id: workerId,
        claimed_at: nowIso,
        lease_until: leaseUntilIso,
        attempts: 1,
      },
    };

    await client.query(
      `UPDATE followup_enrollments
       SET ai_node_session = $1, updated_at = $2
       WHERE organization_id = $3 AND id = $4`,
      [JSON.stringify(updatedSession), nowIso, input.organizationId, enrollment.id],
    );

    // Registra evento de auditoria de início do turno
    await client.query(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.organizationId,
        enrollment.id,
        input.expectedNodeId,
        'ai_node.turn_started',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          turn_count: turnCount,
          last_inbound_at: lastInboundAt,
          worker_id: workerId,
          lease_until: leaseUntilIso,
          media_summary: updatedSession.media_summary,
        }),
        null,
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
      lease_until: leaseUntilIso,
      worker_id: workerId,
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

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string }>(
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

    // Limpa active_turn na sessão do enrollment se ainda existir
    const { rows: enrRows } = await client.query<{
      id: string;
      ai_node_session: AiNodeSession | null;
    }>(
      `SELECT id, ai_node_session FROM followup_enrollments WHERE id = $1 FOR UPDATE`,
      [input.enrollmentId],
    );

    if (enrRows[0]?.ai_node_session?.active_turn) {
      const cleanSession: AiNodeSession = {
        ...enrRows[0].ai_node_session,
        active_turn: null,
      };
      await client.query(
        `UPDATE followup_enrollments SET ai_node_session = $1, updated_at = $2 WHERE id = $3`,
        [JSON.stringify(cleanSession), nowIso, input.enrollmentId],
      );
    }

    await client.query('COMMIT');
    return { status: 'completed', event_id: rows[0]?.id };
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

/**
 * Recupera resposta gerada previamente por LLM no reply cache.
 */
export async function getAiNodeGeneratedReply(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
  },
): Promise<{
  reply_text: string;
  tokens_in?: number;
  tokens_out?: number;
  generated_at?: string;
} | null> {
  const replyKey = buildAiNodeReplyKey(input);
  const { rows } = await db.query<{ payload: Record<string, unknown> | string | null }>(
    `SELECT payload FROM followup_enrollment_events
     WHERE enrollment_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [input.enrollmentId, replyKey],
  );
  if (!rows[0]?.payload) return null;
  const p = (typeof rows[0].payload === 'string'
    ? JSON.parse(rows[0].payload)
    : rows[0].payload) as {
    reply_text: string;
    tokens_in?: number;
    tokens_out?: number;
    generated_at?: string;
  };
  return {
    reply_text: p.reply_text,
    tokens_in: p.tokens_in,
    tokens_out: p.tokens_out,
    generated_at: p.generated_at,
  };
}

/**
 * Avalia se o turno já possui resposta gerada e se o outbound já foi aceito
 * pelo sendWithLedger, viabilizando recuperação idempotente total (Caso E).
 */
export async function resolveAiNodeOutboundRecovery(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
  },
  sendLedgerChecker?: () => Promise<{ status: 'accepted' | 'sent' | 'queued' | 'none' }>,
): Promise<{
  shouldCallLlm: boolean;
  shouldSendOutbound: boolean;
  cachedReply: string | null;
  completed: boolean;
}> {
  const cached = await getAiNodeGeneratedReply(db, input);
  if (!cached) {
    return { shouldCallLlm: true, shouldSendOutbound: true, cachedReply: null, completed: false };
  }

  if (!sendLedgerChecker) {
    return { shouldCallLlm: false, shouldSendOutbound: true, cachedReply: cached.reply_text, completed: false };
  }

  const outboundStatus = await sendLedgerChecker();
  if (outboundStatus.status === 'accepted' || outboundStatus.status === 'sent') {
    await completeAiNodeInboundTurn(db, input);
    return { shouldCallLlm: false, shouldSendOutbound: false, cachedReply: cached.reply_text, completed: true };
  }

  return { shouldCallLlm: false, shouldSendOutbound: true, cachedReply: cached.reply_text, completed: false };
}

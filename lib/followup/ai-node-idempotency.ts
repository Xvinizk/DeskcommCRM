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
      lease_generation: number;
    }
  | {
      /**
       * Takeover de claim expirado (crash do worker anterior após lease timeout).
       * Este worker assumiu atomicamente a titularidade da execução com nova generation.
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
      lease_generation: number;
    }
  | {
      /**
       * Claim existente e AINDA ATIVO (outro worker está processando ou dentro da lease).
       * NÃO processar nem chamar LLM!
       */
      status: 'in_progress';
      is_retry: boolean;
      enrollment_id: string;
      node_id: string;
      inbound_message_id: string;
      active_inbound_message_id?: string;
      worker_id?: string;
      lease_until?: string;
      lease_generation?: number;
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
 * Adquire o claim de execução para um turno inbound no Node IA com lease, isolamento
 * e fencing token monotônico (lease_generation).
 *
 * Estados possíveis:
 * 1. 'acquired'   -> Claim inédito adquirido por este worker (lease_generation: 1). Pode processar.
 * 2. 'in_progress'-> Claim ativo pertencente a outro worker (ou em voo). Não processar.
 * 3. 'resumed'    -> Claim expirou e este worker assumiu takeover atômico (lease_generation: n+1). Pode retomar.
 * 4. 'completed'  -> Turno já foi completamente concluído anteriormente. No-op seguro.
 *
 * Garante:
 * - Mutex CAS via SELECT ... FOR UPDATE no enrollment.
 * - Takeover atômico transacional com incremento de lease_generation.
 * - Workers antigos que expiraram são fenced out (stale_lease_owner) e não conseguem mais gravar.
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
    if (!session || session.status !== 'running' || (session.node_id && session.node_id !== input.expectedNodeId)) {
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

      const activeLeaseUntilStr = session.active_turn?.lease_until ?? (claimPayload?.lease_until as string | undefined);
      const activeWorkerId = session.active_turn?.worker_id ?? (claimPayload?.worker_id as string | undefined);
      const attempts = session.active_turn?.attempts ?? (claimPayload?.attempts as number | undefined) ?? 1;
      const currentGen = session.active_turn?.lease_generation ?? (claimPayload?.lease_generation as number | undefined) ?? 1;

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
          lease_generation: currentGen,
        };
      }

      // CASO C: Claim existe mas a LEASE EXPIROU (worker anterior crashou ou demorou demais sem heartbeat)
      // Executa TAKEOVER ATÔMICO com renovação de lease, incremento de attempts e NOVO FENCING TOKEN (lease_generation + 1).
      // turn_count NÃO é incrementado novamente!
      const newGeneration = currentGen + 1;
      const updatedSession: AiNodeSession = {
        ...session,
        active_turn: {
          inbound_message_id: input.inboundMessageId,
          worker_id: workerId,
          claimed_at: nowIso,
          lease_until: leaseUntilIso,
          attempts: attempts + 1,
          lease_generation: newGeneration,
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
            received_at: (claimPayload?.received_at as string | undefined) ?? nowIso,
            worker_id: workerId,
            claimed_at: nowIso,
            lease_until: leaseUntilIso,
            attempts: attempts + 1,
            lease_generation: newGeneration,
          }),
          enrollment.id,
          claimKey,
        ],
      );

      // Registra evento de auditoria de takeover com fencing token
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
            previous_generation: currentGen,
            new_generation: newGeneration,
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
        lease_generation: newGeneration,
      };
    }

    // 3.1. CASO CONCORRENTE: Se outra mensagem diferente possui turno ATIVO e com lease válida,
    // não permitir que esta nova mensagem sobrescreva o active_turn nem abra LLM concorrente.
    // Serialização segura: uma conversa/enrollment só possui um turno conversacional de Node IA ativo por vez.
    if (
      session.active_turn &&
      session.active_turn.inbound_message_id !== input.inboundMessageId
    ) {
      const activeLeaseUntilStr = session.active_turn.lease_until;
      const leaseUntilMs = activeLeaseUntilStr ? new Date(activeLeaseUntilStr).getTime() : 0;
      const nowMs = now.getTime();

      if (activeLeaseUntilStr && nowMs < leaseUntilMs) {
        await client.query('ROLLBACK');
        return {
          status: 'in_progress',
          is_retry: false,
          enrollment_id: enrollment.id,
          node_id: input.expectedNodeId,
          inbound_message_id: input.inboundMessageId,
          active_inbound_message_id: session.active_turn.inbound_message_id,
          worker_id: session.active_turn.worker_id,
          lease_until: activeLeaseUntilStr,
          lease_generation: session.active_turn.lease_generation,
        };
      }
    }

    // 4. CASO A: Mensagem inédita → Adquirir claim inicial (generation = 1)
    const initialGeneration = 1;
    const inboundEventInsert = await client.query<{ id: string }>(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
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
          lease_generation: initialGeneration,
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
        lease_generation: initialGeneration,
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
        lease_generation: initialGeneration,
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
          lease_generation: initialGeneration,
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
      lease_generation: initialGeneration,
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

export interface RenewAiNodeTurnLeaseInput {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
  workerId: string;
  leaseGeneration: number;
  renewDurationMs?: number;
}

export type RenewAiNodeTurnLeaseResult =
  | {
      status: 'renewed';
      lease_until: string;
      lease_generation: number;
      worker_id: string;
    }
  | {
      status: 'stale_lease_owner';
      current_worker_id?: string;
      current_generation?: number;
      reason: string;
    }
  | {
      status: 'turn_completed' | 'session_not_running' | 'node_changed' | 'not_found';
    };

/**
 * Renova a lease de execução ativa do worker (heartbeat durante operações longas como MCP/Tools/LLM).
 * Exige matching exato do worker_id e lease_generation (fencing token).
 * Se o worker já perdeu a titularidade por takeover, falha com 'stale_lease_owner'.
 */
export async function renewAiNodeTurnLease(
  db: DbPoolLike,
  input: RenewAiNodeTurnLeaseInput,
  deps: { clock?: () => Date } = {},
): Promise<RenewAiNodeTurnLeaseResult> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  const renewDurationMs = input.renewDurationMs ?? 60_000;
  const newLeaseUntilIso = new Date(now.getTime() + renewDurationMs).toISOString();

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{
      id: string;
      current_node_id: string;
      status: string;
      ai_node_session: AiNodeSession | null;
    }>(
      `SELECT id, current_node_id, status, ai_node_session
       FROM followup_enrollments
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE`,
      [input.organizationId, input.enrollmentId],
    );

    const enrollment = rows[0];
    if (!enrollment) {
      await client.query('ROLLBACK');
      return { status: 'not_found' };
    }
    if (enrollment.current_node_id !== input.nodeId) {
      await client.query('ROLLBACK');
      return { status: 'node_changed' };
    }

    const session = enrollment.ai_node_session;
    if (!session || session.status !== 'running') {
      await client.query('ROLLBACK');
      return { status: 'session_not_running' };
    }

    const completedKey = buildAiNodeTurnCompletedKey({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
    });

    const { rows: completedRows } = await client.query<{ id: string }>(
      `SELECT id FROM followup_enrollment_events WHERE enrollment_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [enrollment.id, completedKey],
    );

    if (completedRows.length > 0) {
      await client.query('ROLLBACK');
      return { status: 'turn_completed' };
    }

    const activeTurn = session.active_turn;
    const isOwnerValid =
      activeTurn &&
      activeTurn.inbound_message_id === input.inboundMessageId &&
      activeTurn.worker_id === input.workerId &&
      activeTurn.lease_generation === input.leaseGeneration;

    if (!isOwnerValid) {
      await client.query('ROLLBACK');
      return {
        status: 'stale_lease_owner',
        current_worker_id: activeTurn?.worker_id,
        current_generation: activeTurn?.lease_generation,
        reason: 'Worker is no longer the active lease owner or generation mismatched (takeover occurred)',
      };
    }

    const updatedSession: AiNodeSession = {
      ...session,
      active_turn: {
        ...activeTurn,
        lease_until: newLeaseUntilIso,
      },
    };

    await client.query(
      `UPDATE followup_enrollments SET ai_node_session = $1, updated_at = $2 WHERE organization_id = $3 AND id = $4`,
      [JSON.stringify(updatedSession), nowIso, input.organizationId, enrollment.id],
    );

    const claimKey = buildAiNodeTurnClaimKey({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
    });

    await client.query(
      `UPDATE followup_enrollment_events SET payload = jsonb_set(payload, '{lease_until}', $1::jsonb)
       WHERE enrollment_id = $2 AND idempotency_key = $3`,
      [JSON.stringify(newLeaseUntilIso), enrollment.id, claimKey],
    );

    await client.query('COMMIT');
    return {
      status: 'renewed',
      lease_until: newLeaseUntilIso,
      lease_generation: input.leaseGeneration,
      worker_id: input.workerId,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    release();
  }
}

/**
 * Valida de forma não-bloqueante se o worker ainda é o proprietário legítimo da lease
 * com o fencing token atual antes de acionar tools caras (MCP) ou LLM.
 */
export async function validateAiNodeTurnOwnership(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
    workerId: string;
    leaseGeneration: number;
  },
): Promise<{ is_valid: boolean; reason?: string }> {
  const { rows } = await db.query<{ ai_node_session: AiNodeSession | null }>(
    `SELECT ai_node_session FROM followup_enrollments WHERE organization_id = $1 AND id = $2`,
    [input.organizationId, input.enrollmentId],
  );
  const activeTurn = rows[0]?.ai_node_session?.active_turn;
  if (!activeTurn) {
    return { is_valid: false, reason: 'no_active_turn' };
  }
  if (
    activeTurn.inbound_message_id !== input.inboundMessageId ||
    activeTurn.worker_id !== input.workerId ||
    activeTurn.lease_generation !== input.leaseGeneration
  ) {
    return { is_valid: false, reason: 'stale_lease_owner' };
  }
  return { is_valid: true };
}

export interface CompleteAiNodeInboundTurnInput {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
  outboundMessageId?: string | null;
  /** Fencing token do worker: se fornecido, valida se o worker ainda detém a lease atual */
  workerId?: string;
  leaseGeneration?: number;
}

export type CompleteAiNodeTurnResult =
  | {
      status: 'completed';
      event_id?: string;
    }
  | {
      status: 'stale_lease_owner';
      reason: string;
    };

/**
 * Conclui formalmente o turno do Node IA com validação de fencing token.
 * Um worker que perdeu a titularidade por takeover NÃO PODE marcar completed.
 */
export async function completeAiNodeInboundTurn(
  db: DbPoolLike,
  input: CompleteAiNodeInboundTurnInput,
  deps: { clock?: () => Date } = {},
): Promise<CompleteAiNodeTurnResult> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const completedKey = buildAiNodeTurnCompletedKey(input);

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    // Fencing check: se workerId ou leaseGeneration forem fornecidos, validar ownership
    const { rows: enrRows } = await client.query<{
      id: string;
      ai_node_session: AiNodeSession | string | null;
    }>(
      `SELECT id, ai_node_session FROM followup_enrollments WHERE id = $1 FOR UPDATE`,
      [input.enrollmentId],
    );

    const rawSession = enrRows[0]?.ai_node_session;
    const sessionObj: AiNodeSession | null = rawSession
      ? (typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession)
      : null;

    const activeTurn = sessionObj?.active_turn;
    if (input.workerId !== undefined || input.leaseGeneration !== undefined) {
      const isOwnerValid =
        activeTurn &&
        activeTurn.inbound_message_id === input.inboundMessageId &&
        (input.workerId === undefined || activeTurn.worker_id === input.workerId) &&
        (input.leaseGeneration === undefined || activeTurn.lease_generation === input.leaseGeneration);

      if (!isOwnerValid) {
        await client.query('ROLLBACK');
        return {
          status: 'stale_lease_owner',
          reason: 'Worker is no longer active lease owner (lease expired or takeover occurred)',
        };
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
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
          worker_id: input.workerId ?? activeTurn?.worker_id ?? null,
          lease_generation: input.leaseGeneration ?? activeTurn?.lease_generation ?? null,
          completed_at: nowIso,
        }),
        completedKey,
        nowIso,
      ],
    );

    // Limpa active_turn na sessão do enrollment se ainda houver
    if (sessionObj?.active_turn) {
      const cleanSession: AiNodeSession = {
        ...sessionObj,
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

export interface AiNodeStructuredReply {
  reply: string;
  reply_text: string;
  node_status: 'continue' | 'completed' | 'handoff';
  outcome: string | null;
  extracted_data: Record<string, unknown>;
  agent_id?: string | null;
  agent_version_id?: string | null;
  provider?: string | null;
  model?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  generated_at?: string;
}

export interface RecordAiNodeReplyGeneratedInput {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
  replyText?: string;
  structuredOutput?: {
    reply: string;
    node_status: 'continue' | 'completed' | 'handoff';
    outcome: string | null;
    extracted_data: Record<string, unknown>;
  };
  agentId?: string | null;
  agentVersionId?: string | null;
  provider?: string | null;
  model?: string | null;
  workerId?: string;
  leaseGeneration?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Constrói a chave canônica para confirmação de envio WhatsApp (outbound aceito).
 */
export function buildAiNodeReplySentKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_sent:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

/**
 * Registra envio de resposta para o WhatsApp com idempotência.
 */
export async function recordAiNodeReplySent(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
    crmMessageId?: string | null;
    idempotencyKey?: string;
    workerId?: string;
    leaseGeneration?: number;
  },
  deps: { clock?: () => Date } = {},
): Promise<{ recorded: boolean }> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const sentKey = buildAiNodeReplySentKey(input);

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.reply_sent',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          crm_message_id: input.crmMessageId ?? null,
          worker_id: input.workerId ?? null,
          lease_generation: input.leaseGeneration ?? null,
          sent_at: nowIso,
        }),
        sentKey,
        nowIso,
      ],
    );
    return { recorded: rows.length > 0 };
  } finally {
    release();
  }
}

/**
 * Checa se o envio da resposta para este inbound já foi registrado.
 */
export async function isAiNodeReplyAlreadySent(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
  },
): Promise<{ alreadySent: boolean; crmMessageId?: string | null }> {
  const sentKey = buildAiNodeReplySentKey(input);
  const { rows } = await db.query<{ payload: Record<string, unknown> | string | null }>(
    `SELECT payload FROM followup_enrollment_events
     WHERE enrollment_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [input.enrollmentId, sentKey],
  );
  if (!rows[0]?.payload) return { alreadySent: false };
  const p = (typeof rows[0].payload === 'string'
    ? JSON.parse(rows[0].payload)
    : rows[0].payload) as { crm_message_id?: string | null };
  return { alreadySent: true, crmMessageId: p.crm_message_id ?? null };
}

/**
 * Registra resposta de LLM gerada (Structured Output completo) com validação de fencing token.
 * Se o worker já perdeu a titularidade da lease (takeover), falha com stale_lease_owner
 * e NÃO grava a resposta no cache.
 */
export async function recordAiNodeReplyGenerated(
  db: DbPoolLike,
  input: RecordAiNodeReplyGeneratedInput,
  deps: { clock?: () => Date } = {},
): Promise<{ recorded: boolean; error?: string }> {
  const clock = deps.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const replyKey = buildAiNodeReplyKey(input);

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = 'release' in client && typeof client.release === 'function' ? () => client.release() : () => {};

  try {
    await client.query('BEGIN');

    // Fencing check: se workerId ou leaseGeneration forem fornecidos, validar ownership
    if (input.workerId !== undefined || input.leaseGeneration !== undefined) {
      const { rows: enrRows } = await client.query<{ ai_node_session: AiNodeSession | null }>(
        `SELECT ai_node_session FROM followup_enrollments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [input.organizationId, input.enrollmentId],
      );

      const activeTurn = enrRows[0]?.ai_node_session?.active_turn;
      const isOwnerValid =
        activeTurn &&
        activeTurn.inbound_message_id === input.inboundMessageId &&
        (input.workerId === undefined || activeTurn.worker_id === input.workerId) &&
        (input.leaseGeneration === undefined || activeTurn.lease_generation === input.leaseGeneration);

      if (!isOwnerValid) {
        await client.query('ROLLBACK');
        return { recorded: false, error: 'stale_lease_owner' };
      }
    }

    const reply = input.structuredOutput?.reply ?? input.replyText ?? '';
    const nodeStatus = input.structuredOutput?.node_status ?? 'continue';
    const outcome = input.structuredOutput?.outcome ?? null;
    const extractedData = input.structuredOutput?.extracted_data ?? {};

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO followup_enrollment_events (
         organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (enrollment_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.organizationId,
        input.enrollmentId,
        input.nodeId,
        'ai_node.reply_generated',
        JSON.stringify({
          inbound_message_id: input.inboundMessageId,
          worker_id: input.workerId ?? null,
          lease_generation: input.leaseGeneration ?? null,
          reply_text: reply,
          reply,
          node_status: nodeStatus,
          outcome,
          extracted_data: extractedData,
          agent_id: input.agentId ?? null,
          agent_version_id: input.agentVersionId ?? null,
          provider: input.provider ?? null,
          model: input.model ?? null,
          tokens_in: input.tokensIn ?? 0,
          tokens_out: input.tokensOut ?? 0,
          generated_at: nowIso,
        }),
        replyKey,
        nowIso,
      ],
    );

    await client.query('COMMIT');
    return { recorded: rows.length > 0 };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    release();
  }
}

/**
 * Recupera resposta gerada previamente por LLM no reply cache (formato estruturado completo).
 */
export async function getAiNodeGeneratedReply(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
  },
): Promise<AiNodeStructuredReply | null> {
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
    reply_text?: string;
    reply?: string;
    node_status?: 'continue' | 'completed' | 'handoff';
    outcome?: string | null;
    extracted_data?: Record<string, unknown>;
    agent_id?: string | null;
    agent_version_id?: string | null;
    provider?: string | null;
    model?: string | null;
    tokens_in?: number;
    tokens_out?: number;
    generated_at?: string;
  };
  const reply = p.reply ?? p.reply_text ?? '';
  return {
    reply,
    reply_text: p.reply_text ?? reply,
    node_status: p.node_status ?? 'continue',
    outcome: p.outcome ?? null,
    extracted_data: p.extracted_data ?? {},
    agent_id: p.agent_id ?? null,
    agent_version_id: p.agent_version_id ?? null,
    provider: p.provider ?? null,
    model: p.model ?? null,
    tokens_in: p.tokens_in,
    tokens_out: p.tokens_out,
    generated_at: p.generated_at,
  };
}

/**
 * Avalia se o turno já possui resposta gerada e se o outbound já foi aceito
 * pelo sendWithLedger, viabilizando recuperação idempotente total (Caso E).
 * Suporta fencing token para rejeitar stale workers.
 */
export async function resolveAiNodeOutboundRecovery(
  db: DbPoolLike,
  input: {
    organizationId: string;
    enrollmentId: string;
    nodeId: string;
    inboundMessageId: string;
    workerId?: string;
    leaseGeneration?: number;
  },
  sendLedgerChecker?: () => Promise<{ status: 'accepted' | 'sent' | 'queued' | 'none' }>,
): Promise<{
  shouldCallLlm: boolean;
  shouldSendOutbound: boolean;
  cachedReply: string | null;
  completed: boolean;
  stale?: boolean;
}> {
  // Fencing check: se workerId e leaseGeneration foram passados, verificar ownership
  if (input.workerId && input.leaseGeneration) {
    const ownership = await validateAiNodeTurnOwnership(db, {
      organizationId: input.organizationId,
      enrollmentId: input.enrollmentId,
      nodeId: input.nodeId,
      inboundMessageId: input.inboundMessageId,
      workerId: input.workerId,
      leaseGeneration: input.leaseGeneration,
    });
    if (!ownership.is_valid) {
      return { shouldCallLlm: false, shouldSendOutbound: false, cachedReply: null, completed: false, stale: true };
    }
  }

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

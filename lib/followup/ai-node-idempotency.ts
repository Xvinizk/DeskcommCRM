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
      enrollment_id: string;
      node_id: string;
      agent_id: string | null;
      agent_version_id: string | null;
      inbound_message_id: string;
      turn_count: number;
      session: AiNodeSession;
    }
  | {
      status: 'already_processed';
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
 * Constrói a chave canônica de idempotência para o turno inbound no Node IA.
 */
export function buildAiNodeTurnIdempotencyKey(params: {
  organizationId: string;
  enrollmentId: string;
  nodeId: string;
  inboundMessageId: string;
}): string {
  return `ai_node_turn:${params.organizationId}:${params.enrollmentId}:${params.nodeId}:${params.inboundMessageId}`;
}

/**
 * Adquire a idempotência e resolve atomicamente a corrida (Timeout x Inbound) para o Node IA.
 *
 * Garante:
 * 1. Lock CAS via SELECT ... FOR UPDATE no enrollment.
 * 2. Se o nó já mudou (timeout correu antes), desiste sem incrementar turn_count (Cenário B).
 * 3. Adquire idempotência em `followup_enrollment_events` ANTES de qualquer mutação.
 * 4. Incrementa turn_count exatamente 1 vez por mensagem física única.
 * 5. Atualiza last_inbound_at e media_summary de forma determinística.
 * 6. Emite apenas os eventos permitidos nesta fase: `ai_node.inbound_received` e `ai_node.turn_started`.
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

    // 2. Idempotência estrita: adquirida ANTES de qualquer mutação
    const idempotencyKey = buildAiNodeTurnIdempotencyKey({
      organizationId: input.organizationId,
      enrollmentId: enrollment.id,
      nodeId: input.expectedNodeId,
      inboundMessageId: input.inboundMessageId,
    });

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
        idempotencyKey,
        nowIso,
      ],
    );

    // Se já existia (retries / mensagens duplicadas recebidas concorrentemente):
    if (inboundEventInsert.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        status: 'already_processed',
        enrollment_id: enrollment.id,
        node_id: input.expectedNodeId,
        inbound_message_id: input.inboundMessageId,
      };
    }

    // 3. Mutação atômica do session (turn_count, last_inbound_at, media_summary)
    const turnCount = (session.turn_count ?? 0) + 1;
    const lastInboundAt = input.messageSentAt
      ? new Date(input.messageSentAt).toISOString()
      : nowIso;

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

    // 4. Emite evento permitido: ai_node.turn_started
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

import { describe, expect, it } from 'vitest';
import {
  acquireAiNodeInboundTurn,
  completeAiNodeInboundTurn,
  buildAiNodeTurnClaimKey,
  buildAiNodeTurnCompletedKey,
  buildAiNodeTurnIdempotencyKey,
  type DbPoolLike,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';

export function createMockDb(initialEnrollment: {
  id: string;
  organization_id: string;
  current_node_id: string;
  status: string;
  ai_node_session: AiNodeSession | null;
  conversation_id: string | null;
}) {
  const enrollment = { ...initialEnrollment };
  const events: Array<{
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown> | null;
    idempotency_key: string | null;
    created_at?: string;
  }> = [];

  let lockChain = Promise.resolve();

  function createClient() {
    let acquiredLock = false;
    let releaseFn: () => void = () => {};

    return {
      async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
        const normalizedSql = sql.trim().replace(/\s+/g, ' ');

        if (normalizedSql.includes('FOR UPDATE') && !acquiredLock) {
          let resolver: () => void;
          const currentLock = new Promise<void>((r) => {
            resolver = r;
          });
          const prevLock = lockChain;
          lockChain = prevLock.then(() => currentLock);
          await prevLock;
          acquiredLock = true;
          releaseFn = resolver!;
        }

        if (normalizedSql.startsWith('COMMIT') || normalizedSql.startsWith('ROLLBACK')) {
          if (acquiredLock) {
            acquiredLock = false;
            releaseFn();
          }
          return { rows: [] };
        }

        if (
          normalizedSql.includes('FROM followup_enrollments') &&
          (normalizedSql.includes('WHERE id = $1') ||
            normalizedSql.includes('WHERE organization_id = $1 AND id = $2') ||
            normalizedSql.includes('SELECT ai_node_session FROM followup_enrollments'))
        ) {
          const orgId = params.length === 2 ? (params[0] as string) : enrollment.organization_id;
          const enrollmentId = params.length === 2 ? (params[1] as string) : (params[0] as string);
          if (enrollment.organization_id === orgId && enrollment.id === enrollmentId) {
            return {
              rows: [
                {
                  id: enrollment.id,
                  current_node_id: enrollment.current_node_id,
                  status: enrollment.status,
                  ai_node_session: enrollment.ai_node_session,
                  conversation_id: enrollment.conversation_id,
                } as T,
              ],
            };
          }
          return { rows: [] };
        }

        if (normalizedSql.includes('FROM followup_enrollment_events') && normalizedSql.includes('SELECT id')) {
          const [enrollmentId, idemKey] = params;
          const found = events.find((e) => e.enrollment_id === enrollmentId && e.idempotency_key === idemKey);
          return {
            rows: found
              ? [
                  {
                    id: 'event-uuid',
                    payload: found.payload,
                    created_at: found.created_at ?? new Date().toISOString(),
                  } as T,
                ]
              : [],
          };
        }

        if (normalizedSql.includes('FROM followup_enrollment_events') && normalizedSql.includes('SELECT payload')) {
          const [enrollmentId, idemKey] = params;
          const found = events.find((e) => e.enrollment_id === enrollmentId && e.idempotency_key === idemKey);
          return {
            rows: found ? [{ payload: found.payload } as T] : [],
          };
        }

        if (normalizedSql.includes('UPDATE followup_enrollment_events SET payload')) {
          const [payloadArg, enrollmentId, idemKey] = params;
          const existingIdx = events.findIndex(
            (e) => e.enrollment_id === enrollmentId && e.idempotency_key === idemKey,
          );
          if (existingIdx >= 0) {
            if (normalizedSql.includes('jsonb_set')) {
              events[existingIdx]!.payload = {
                ...events[existingIdx]!.payload,
                lease_until: JSON.parse(payloadArg as string),
              };
            } else {
              events[existingIdx]!.payload = JSON.parse(payloadArg as string);
            }
          }
          return { rows: [] };
        }

        if (normalizedSql.includes('INSERT INTO followup_enrollment_events')) {
          const [orgId, enrollmentId, nodeId, eventType, payloadStr, idemKey, createdAt] = params;
          const key = idemKey as string | null;

          if (key) {
            const existingIdx = events.findIndex((e) => e.enrollment_id === enrollmentId && e.idempotency_key === key);
            if (existingIdx >= 0) {
              if (normalizedSql.includes('DO UPDATE')) {
                events[existingIdx]!.payload = JSON.parse(payloadStr as string);
                return { rows: [{ id: 'event-uuid-' + existingIdx } as T] };
              }
              // ON CONFLICT DO NOTHING
              return { rows: [] };
            }
          }

          const newEvent = {
            organization_id: orgId as string,
            enrollment_id: enrollmentId as string,
            node_id: nodeId as string,
            event_type: eventType as string,
            payload: JSON.parse(payloadStr as string),
            idempotency_key: key,
            created_at: (createdAt as string) ?? new Date().toISOString(),
          };
          events.push(newEvent);
          return { rows: [{ id: 'event-uuid-' + events.length } as T] };
        }

        if (normalizedSql.includes('UPDATE followup_enrollments SET ai_node_session')) {
          const [sessionJson, _updatedAt, orgId, enrollmentId] = params;
          if (enrollment.organization_id === orgId && enrollment.id === enrollmentId) {
            enrollment.ai_node_session = JSON.parse(sessionJson as string);
          } else if (params.length === 3 && enrollment.id === params[2]) {
            enrollment.ai_node_session = JSON.parse(sessionJson as string);
          }
          return { rows: [] };
        }

        return { rows: [] };
      },
      release() {
        if (acquiredLock) {
          acquiredLock = false;
          releaseFn();
        }
      },
    };
  }

  const mockDb: DbPoolLike = {
    async connect() {
      return createClient();
    },
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const client = createClient();
      try {
        return await client.query<T>(sql, params);
      } finally {
        client.release();
      }
    },
  };

  return {
    mockDb,
    getEnrollment: () => enrollment,
    getEvents: () => events,
  };
}

describe('ai-node-idempotency', () => {
  it('gera as chaves canônicas corretas de claim e conclusão', () => {
    const claimKey = buildAiNodeTurnClaimKey({
      organizationId: 'org-1',
      enrollmentId: 'enr-2',
      nodeId: 'node-3',
      inboundMessageId: 'msg-4',
    });
    expect(claimKey).toBe('ai_node_claim:org-1:enr-2:node-3:msg-4');

    const completedKey = buildAiNodeTurnCompletedKey({
      organizationId: 'org-1',
      enrollmentId: 'enr-2',
      nodeId: 'node-3',
      inboundMessageId: 'msg-4',
    });
    expect(completedKey).toBe('ai_node_completed:org-1:enr-2:node-3:msg-4');

    expect(buildAiNodeTurnIdempotencyKey({
      organizationId: 'org-1',
      enrollmentId: 'enr-2',
      nodeId: 'node-3',
      inboundMessageId: 'msg-4',
    })).toBe(claimKey);
  });

  it('lifecycle de claim com lease e fencing token: acquired (gen 1) -> in_progress -> resumed (gen 2) -> completed', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-main',
      flow_id: 'flow-123',
      mode: 'existing_agent',
      agent_id: 'a0000000-0000-0000-0000-000000000001',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T10:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment, getEvents } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-main',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    const fixedMessageId = 'msg-phys-unique-999';
    const input = {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-main',
      inboundMessageId: fixedMessageId,
      messageSentAt: '2026-09-30T10:05:00Z',
      leaseDurationMs: 60_000,
      workerId: 'worker-initial',
    };

    // 1ª execução em t0 = 10:05:00 (claim inédito com generation = 1)
    let currentTime = new Date('2026-09-30T10:05:00Z');
    const result1 = await acquireAiNodeInboundTurn(mockDb, input, { clock: () => currentTime });
    expect(result1.status).toBe('acquired');
    if (result1.status === 'acquired') {
      expect(result1.is_retry).toBe(false);
      expect(result1.turn_count).toBe(1);
      expect(result1.session.turn_count).toBe(1);
      expect(result1.session.last_inbound_at).toBe('2026-09-30T10:05:00.000Z');
      expect(result1.lease_until).toBe('2026-09-30T10:06:00.000Z');
      expect(result1.lease_generation).toBe(1);
    }

    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
    expect(getEvents().filter((e) => e.event_type === 'ai_node.inbound_received')).toHaveLength(1);

    // 2ª execução em t0 + 10s = 10:05:10 (dentro da lease de 60s):
    // Retorna in_progress
    currentTime = new Date('2026-09-30T10:05:10Z');
    const retryInProgress = await acquireAiNodeInboundTurn(mockDb, input, { clock: () => currentTime });
    expect(retryInProgress.status).toBe('in_progress');
    if (retryInProgress.status === 'in_progress') {
      expect(retryInProgress.is_retry).toBe(true);
      expect(retryInProgress.lease_until).toBe('2026-09-30T10:06:00.000Z');
      expect(retryInProgress.lease_generation).toBe(1);
    }

    // turn_count permanece exatamente 1
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // 3ª execução em t0 + 70s = 10:06:10 (lease expirou):
    // Takeover atômico com generation = 2
    currentTime = new Date('2026-09-30T10:06:10Z');
    const retryResumed = await acquireAiNodeInboundTurn(
      mockDb,
      { ...input, workerId: 'worker-takeover' },
      { clock: () => currentTime },
    );
    expect(retryResumed.status).toBe('resumed');
    if (retryResumed.status === 'resumed') {
      expect(retryResumed.is_retry).toBe(true);
      expect(retryResumed.turn_count).toBe(1);
      expect(retryResumed.worker_id).toBe('worker-takeover');
      expect(retryResumed.lease_until).toBe('2026-09-30T10:07:10.000Z');
      expect(retryResumed.lease_generation).toBe(2);
    }

    // turn_count permanece 1
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // Turno conclui formalmente pelo worker legítimo (worker-takeover, gen 2):
    const completeResult = await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-main',
      inboundMessageId: fixedMessageId,
      outboundMessageId: 'out-msg-1',
      workerId: 'worker-takeover',
      leaseGeneration: 2,
    });
    expect(completeResult.status).toBe('completed');

    // Tentativas após a conclusão devem retornar 'completed' (no-op seguro):
    currentTime = new Date('2026-09-30T10:10:00Z');
    const postCompleteResult = await acquireAiNodeInboundTurn(mockDb, input, { clock: () => currentTime });
    expect(postCompleteResult.status).toBe('completed');
    if (postCompleteResult.status === 'completed') {
      expect(postCompleteResult.is_retry).toBe(true);
    }
  });

  it('uma SEGUNDA mensagem inbound diferente incrementa turn_count para 2', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-main',
      flow_id: 'flow-123',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T10:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment } = createMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-main',
      status: 'active',
      ai_node_session: initialSession,
      conversation_id: 'conv-1',
    });

    // Mensagem 1
    const res1 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-main',
      inboundMessageId: 'msg-1',
    });
    expect(res1.status).toBe('acquired');
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // Mensagem 2 (diferente)
    const res2 = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-main',
      inboundMessageId: 'msg-2',
    });
    expect(res2.status).toBe('acquired');
    expect(getEnrollment().ai_node_session?.turn_count).toBe(2);
  });
});

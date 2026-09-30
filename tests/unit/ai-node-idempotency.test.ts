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

/**
 * Cria um mock de banco simulando o comportamento transacional do PostgreSQL,
 * incluindo lock CAS e constraint UNIQUE em (enrollment_id, idempotency_key).
 */
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
    payload: unknown;
    idempotency_key: string;
  }> = [];

  const mockDb: DbPoolLike = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      if (normalizedSql.startsWith('BEGIN') || normalizedSql.startsWith('COMMIT') || normalizedSql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      if (normalizedSql.includes('FROM followup_enrollments') && normalizedSql.includes('FOR UPDATE')) {
        const [orgId, enrollmentId] = params;
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
        return { rows: found ? [{ id: 'event-uuid' } as T] : [] };
      }

      if (normalizedSql.includes('INSERT INTO followup_enrollment_events')) {
        const [orgId, enrollmentId, nodeId, eventType, payloadStr, idemKey] = params;
        const key = idemKey as string;

        const existingIdx = events.findIndex((e) => e.enrollment_id === enrollmentId && e.idempotency_key === key);
        if (existingIdx >= 0) {
          if (normalizedSql.includes('DO UPDATE')) {
            events[existingIdx]!.payload = JSON.parse(payloadStr as string);
            return { rows: [{ id: 'event-uuid-' + existingIdx } as T] };
          }
          // ON CONFLICT DO NOTHING
          return { rows: [] };
        }

        const newEvent = {
          organization_id: orgId as string,
          enrollment_id: enrollmentId as string,
          node_id: nodeId as string,
          event_type: eventType as string,
          payload: JSON.parse(payloadStr as string),
          idempotency_key: key,
        };
        events.push(newEvent);
        return { rows: [{ id: 'event-uuid-' + events.length } as T] };
      }

      if (normalizedSql.includes('UPDATE followup_enrollments SET ai_node_session')) {
        const [sessionJson, _updatedAt, orgId, enrollmentId] = params;
        if (enrollment.organization_id === orgId && enrollment.id === enrollmentId) {
          enrollment.ai_node_session = JSON.parse(sessionJson as string);
        }
        return { rows: [] };
      }

      return { rows: [] };
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

  it('mesmo inbound_message_id em crash/retry retoma (resumed) sem duplicar turn_count', async () => {
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
    };

    // 1ª execução: claim inédito
    const result1 = await acquireAiNodeInboundTurn(mockDb, input);
    expect(result1.status).toBe('acquired');
    if (result1.status === 'acquired') {
      expect(result1.is_retry).toBe(false);
      expect(result1.turn_count).toBe(1);
      expect(result1.session.turn_count).toBe(1);
      expect(result1.session.last_inbound_at).toBe('2026-09-30T10:05:00.000Z');
    }

    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
    expect(getEvents().filter((e) => e.event_type === 'ai_node.inbound_received')).toHaveLength(1);

    // 2ª a 5ª execuções enquanto NÃO concluído (retries pós-crash):
    // Deve retornar 'resumed' e permitir a continuação sem re-incrementar turn_count!
    for (let i = 2; i <= 5; i++) {
      const retryResult = await acquireAiNodeInboundTurn(mockDb, input);
      expect(retryResult.status).toBe('resumed');
      if (retryResult.status === 'resumed') {
        expect(retryResult.is_retry).toBe(true);
        expect(retryResult.turn_count).toBe(1);
        expect(retryResult.inbound_message_id).toBe(fixedMessageId);
      }
    }

    // turn_count permanece exatamente 1!
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);

    // Agora o turno conclui formalmente (resposta enviada no WhatsApp):
    await completeAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      nodeId: 'node-ai-main',
      inboundMessageId: fixedMessageId,
      outboundMessageId: 'out-msg-1',
    });

    // Tentativas após a conclusão devem retornar 'completed' (no-op seguro):
    const postCompleteResult = await acquireAiNodeInboundTurn(mockDb, input);
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

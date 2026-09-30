import { describe, expect, it } from 'vitest';
import {
  acquireAiNodeInboundTurn,
  type DbPoolLike,
} from '@/lib/followup/ai-node-idempotency';
import type { AiNodeSession } from '@/lib/followup/ai-node-session';

function createRaceMockDb(initialEnrollment: {
  id: string;
  organization_id: string;
  current_node_id: string;
  status: string;
  ai_node_session: AiNodeSession | null;
}) {
  const enrollment = { ...initialEnrollment };
  const events: Array<{ event_type: string; idempotency_key: string }> = [];

  const mockDb: DbPoolLike = {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const normalizedSql = sql.trim().replace(/\s+/g, ' ');

      if (normalizedSql.startsWith('BEGIN') || normalizedSql.startsWith('COMMIT') || normalizedSql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      if (normalizedSql.includes('FROM followup_enrollments') && normalizedSql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              id: enrollment.id,
              current_node_id: enrollment.current_node_id,
              status: enrollment.status,
              ai_node_session: enrollment.ai_node_session,
              conversation_id: null,
            } as T,
          ],
        };
      }

      if (normalizedSql.includes('INSERT INTO followup_enrollment_events')) {
        const [, , , eventType, , idemKey] = params;
        events.push({ event_type: eventType as string, idempotency_key: idemKey as string });
        return { rows: [{ id: 'event-uuid' } as T] };
      }

      if (normalizedSql.includes('UPDATE followup_enrollments SET ai_node_session')) {
        const [sessionJson] = params;
        enrollment.ai_node_session = JSON.parse(sessionJson as string);
        return { rows: [] };
      }

      return { rows: [] };
    },
  };

  return {
    mockDb,
    getEnrollment: () => enrollment,
    transitionToNextNode: (newNodeId: string) => {
      // Simula a transição realizada pelo worker de timeout
      enrollment.current_node_id = newNodeId;
    },
    getEvents: () => events,
  };
}

describe('ai-node-timeout-race', () => {
  it('CENÁRIO A: Inbound ganha lock primeiro → confirma nó atual, registra inbound e atualiza last_inbound_at', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment, getEvents } = createRaceMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
    });

    const res = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-100',
      messageSentAt: '2026-09-30T12:05:00Z',
    });

    expect(res.status).toBe('acquired');
    if (res.status === 'acquired') {
      expect(res.turn_count).toBe(1);
      expect(res.session.last_inbound_at).toBe('2026-09-30T12:05:00.000Z');
      expect(res.session.turn_count).toBe(1);
    }

    // Enrollment foi atualizado corretamente no banco
    expect(getEnrollment().ai_node_session?.turn_count).toBe(1);
    expect(getEnrollment().ai_node_session?.last_inbound_at).toBe('2026-09-30T12:05:00.000Z');

    // Eventos emitidos
    expect(getEvents().map((e) => e.event_type)).toEqual([
      'ai_node.inbound_received',
      'ai_node.turn_started',
    ]);
  });

  it('CENÁRIO B: Timeout/transição ganha lock antes e altera current_node_id → Inbound tardio detecta node_changed e NÃO processa', async () => {
    const initialSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'running',
      turn_count: 0,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment, transitionToNextNode, getEvents } = createRaceMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: initialSession,
    });

    // 1. Timeout ganha a corrida e avança o fluxo para o próximo nó
    transitionToNextNode('node-timeout-fallback');

    // 2. Inbound que estava em voo tenta executar no nó antigo ('node-ai-1')
    const res = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-late',
    });

    // 3. Deve detectar que o nó mudou
    expect(res.status).toBe('node_changed');
    if (res.status === 'node_changed') {
      expect(res.currentNodeId).toBe('node-timeout-fallback');
      expect(res.expectedNodeId).toBe('node-ai-1');
    }

    // 4. Garantia estrita: NÃO processa nó antigo, NÃO incrementa turn_count e NÃO emite eventos
    expect(getEnrollment().current_node_id).toBe('node-timeout-fallback');
    expect(getEnrollment().ai_node_session?.turn_count).toBe(0);
    expect(getEvents()).toHaveLength(0);
  });

  it('Inbound tardio não muta se status da sessão não for mais running', async () => {
    const closedSession: AiNodeSession = {
      node_id: 'node-ai-1',
      flow_id: 'flow-1',
      mode: 'existing_agent',
      status: 'completed', // Finalizado por timeout ou branch
      turn_count: 2,
      started_at: '2026-09-30T12:00:00Z',
      media_summary: {
        images_count: 0,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    };

    const { mockDb, getEnrollment, getEvents } = createRaceMockDb({
      id: 'enrollment-1',
      organization_id: 'org-1',
      current_node_id: 'node-ai-1',
      status: 'active',
      ai_node_session: closedSession,
    });

    const res = await acquireAiNodeInboundTurn(mockDb, {
      organizationId: 'org-1',
      enrollmentId: 'enrollment-1',
      expectedNodeId: 'node-ai-1',
      inboundMessageId: 'msg-inbound-after-close',
    });

    expect(res.status).toBe('session_not_running');
    expect(getEnrollment().ai_node_session?.turn_count).toBe(2); // Inalterado
    expect(getEvents()).toHaveLength(0);
  });
});

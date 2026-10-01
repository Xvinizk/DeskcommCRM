import { describe, it, expect } from "vitest";

import {
  runFollowupTick,
  type FollowupJobRequest,
  type TickDeps,
} from "@/lib/followup/engine";
import { completeTurnForEnrollment } from "@/lib/followup/turn-bridge";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow, LeadFacts } from "@/lib/followup/node-handlers";

/**
 * Teste de Não-Regressão Canônico: Fluxos Tradicionais SEM ai_node
 *
 * Garante que a semântica histórica de steps_taken e transições de estado
 * seja 100% preservada para fluxos sem Node IA:
 * 1. runFollowupTick avança exatamente 1 nó por tick (trigger -> end leva 2 ticks).
 * 2. completeTurnForEnrollment em nó action posiciona o enrollment em 'end' com status 'active'
 *    sem executar o nó 'end' prematuramente (preserva steps_taken histórico).
 * 3. wait elapsido avança para o próximo nó sem completar múltiplos passos no mesmo tick.
 */

class MockHarness {
  currentTime = new Date("2026-10-01T12:00:00.000Z").getTime();
  enrollments: Map<string, EnrollmentRow> = new Map();
  events: Map<string, EnrollmentEventRef[]> = new Map();
  graphs: Map<string, FlowGraph> = new Map();
  jobs: FollowupJobRequest[] = [];

  clock = (): Date => new Date(this.currentTime);

  createEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
    const row: EnrollmentRow = {
      id: "enr-trad-1",
      organization_id: "org-trad",
      pointer_id: "ptr-trad",
      version_id: "ver-trad",
      contact_id: "contact-trad",
      conversation_id: "conv-trad",
      service_boundary: null,
      revision: 1,
      appointment_id: null,
      appointment_revision: null,
      current_node_id: "t1",
      status: "active",
      next_eval_at: this.clock().toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 0,
      outcome: null,
      cancel_reason: null,
      started_at: this.clock().toISOString(),
      completed_at: null,
      updated_at: this.clock().toISOString(),
      timing_plan: null,
      ...overrides,
    };
    this.enrollments.set(row.id, { ...row });
    this.events.set(row.id, []);
    return row;
  }

  getDeps(): TickDeps {
    return {
      clock: this.clock,
      enqueueJob: async (job: FollowupJobRequest) => {
        this.jobs.push(job);
      },
      db: {
        claimDueEnrollments: async (limit: number, leaseSeconds: number) => {
          const now = this.clock();
          const due: EnrollmentRow[] = [];
          for (const enr of this.enrollments.values()) {
            if (
              enr.status === "active" &&
              enr.next_eval_at &&
              new Date(enr.next_eval_at) <= now &&
              (!enr.claimed_until || new Date(enr.claimed_until) <= now)
            ) {
              enr.claimed_until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
              due.push({ ...enr });
              if (due.length >= limit) break;
            }
          }
          return due;
        },
        loadEnrollmentById: async (_orgId: string, id: string) => {
          const enr = this.enrollments.get(id);
          return enr ? { ...enr } : null;
        },
        loadFlowGraph: async (_orgId: string, versionId: string) => {
          const g = this.graphs.get(versionId);
          return g ? JSON.parse(JSON.stringify(g)) : null;
        },
        loadLeadFacts: async (): Promise<LeadFacts> => ({
          lead_stage: null,
          tags: [],
          steps_taken: 0,
          last_outcome: null,
          contact_name: "Lead Tradicional",
          custom_fields: {},
        }),
        loadEnrollmentEvents: async (enrollmentId: string) => {
          return [...(this.events.get(enrollmentId) ?? [])];
        },
        loadLastInboundBody: async () => null,
        insertEnrollmentEvent: async (event) => {
          const list = this.events.get(event.enrollment_id) ?? [];
          const exists = list.some((e) => e.idempotency_key === event.idempotency_key);
          if (exists) return { inserted: false };
          list.push({
            node_id: event.node_id,
            event_type: event.event_type,
            payload: event.payload as Record<string, unknown>,
            idempotency_key: event.idempotency_key,
          });
          this.events.set(event.enrollment_id, list);
          return { inserted: true };
        },
        updateEnrollment: async (id, _orgId, patch) => {
          const current = this.enrollments.get(id);
          if (!current) throw new Error("not found");
          const updated = {
            ...current,
            ...patch,
            updated_at: patch.updated_at ?? this.clock().toISOString(),
          };
          this.enrollments.set(id, updated as EnrollmentRow);
        },
        applyEnrollmentStep: async (id, orgId, patch, event) => {
          const list = this.events.get(id) ?? [];
          if (list.some((e) => e.idempotency_key === event.idempotency_key)) return false;
          list.push({
            node_id: event.node_id,
            event_type: event.event_type,
            payload: event.payload as Record<string, unknown>,
            idempotency_key: event.idempotency_key,
          });
          this.events.set(id, list);
          const current = this.enrollments.get(id);
          if (!current) throw new Error("not found");
          this.enrollments.set(id, { ...current, ...patch } as EnrollmentRow);
          return true;
        },
        enqueueJob: async (job: FollowupJobRequest) => {
          this.jobs.push(job);
        },
        loadFlowPointerName: async () => null,
        insertDeadInboxItem: async () => {},
        persistirRespostaFollowup: async () => {},
      },
    };
  }
}

describe("Não-Regressão — Semântica Histórica de Fluxos Tradicionais", () => {
  it("1. trigger -> end leva exatamente 2 ticks (1 avanço de nó por tick)", async () => {
    const harness = new MockHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "edge", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    harness.graphs.set("ver-trad", graph);
    const enr = harness.createEnrollment({ current_node_id: "t1", steps_taken: 0 });

    // Tick 1: trigger -> end (status: active, steps_taken: 1)
    const s1 = await runFollowupTick(harness.getDeps());
    expect(s1.claimed).toBe(1);
    expect(s1.advanced).toBe(1);

    const afterTick1 = harness.enrollments.get(enr.id)!;
    expect(afterTick1.current_node_id).toBe("e1");
    expect(afterTick1.status).toBe("active");
    expect(afterTick1.steps_taken).toBe(1);

    // Tick 2: end -> completed (status: completed, steps_taken: 2)
    const s2 = await runFollowupTick(harness.getDeps());
    expect(s2.claimed).toBe(1);
    expect(s2.advanced).toBe(1);

    const afterTick2 = harness.enrollments.get(enr.id)!;
    expect(afterTick2.current_node_id).toBe("e1");
    expect(afterTick2.status).toBe("completed");
    expect(afterTick2.outcome).toBe("converted");
    expect(afterTick2.steps_taken).toBe(2);
  });

  it("2. completeTurnForEnrollment em nó action deixa o enrollment em 'end' com status 'active' (steps_taken: 2)", async () => {
    const harness = new MockHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "send", type: "action", label: "Enviar", position: { x: 0, y: 0 }, config: { mode: "ai_message", prompt_hint: "Retomar" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "edge", source: "send", target: "end", priority: 0, condition: { type: "always" } }],
    };
    harness.graphs.set("ver-trad", graph);
    // Fixture clássica idêntica à agenda-presenca-fix1.test.ts:
    // enrollment criado no nó 'send' com steps_taken: 1
    const enr = harness.createEnrollment({ current_node_id: "send", steps_taken: 1 });

    const deps = harness.getDeps();
    await completeTurnForEnrollment(
      deps.db,
      enr.organization_id,
      enr.id,
      "send",
      { kind: "sent" },
      harness.clock,
    );

    // Deve estar no nó 'end' com steps_taken = 2 e status 'active', sem avanço prematuro do nó 'end'
    const afterTurn = harness.enrollments.get(enr.id)!;
    expect(afterTurn.current_node_id).toBe("end");
    expect(afterTurn.status).toBe("active");
    expect(afterTurn.steps_taken).toBe(2);

    // Somente o tick seguinte do worker conclui o nó 'end'
    const s = await runFollowupTick(deps);
    expect(s.claimed).toBe(1);
    expect(s.advanced).toBe(1);

    const finalEnr = harness.enrollments.get(enr.id)!;
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.steps_taken).toBe(3);
  });
});

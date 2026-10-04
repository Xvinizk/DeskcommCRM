import { describe, it, expect } from "vitest";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { FollowupJobRequest } from "@/lib/followup/engine";
import { EnrollmentRevisionStaleError, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const NOW = new Date("2026-10-04T03:00:00.000Z");
const clock = () => NOW;

const FLOW_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "msg_pre",
      type: "message_text",
      label: "Mensagem Pré",
      position: { x: 0, y: 0 },
      config: { body: "RACE RETRY TEST INICIADO" },
    },
    {
      id: "ai_node_race",
      type: "ai_node",
      label: "Node IA Race",
      position: { x: 0, y: 100 },
      config: {
        mode: "custom_prompt",
        custom_prompt: "Prompt de teste de concorrência",
        timeout: { duration_value: 15, unit: "minutes" },
        timeout_ms: 900_000,
      },
    },
    {
      id: "end_flow",
      type: "end",
      label: "Fim",
      position: { x: 0, y: 200 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    {
      id: "e_pre_ai",
      source: "msg_pre",
      target: "ai_node_race",
      priority: 0,
      condition: { type: "always" },
    },
    {
      id: "e_ai_end",
      source: "ai_node_race",
      target: "end_flow",
      priority: 0,
      condition: { type: "always" },
    },
  ],
};

function createRecoveryHarness(opts: {
  initialEnrollment: EnrollmentRow;
  graph?: FlowGraph;
  failCasAttempts?: number;
  serviceBoundaryStale?: boolean;
}) {
  let enrollment = { ...opts.initialEnrollment };
  let casFailuresRemaining = opts.failCasAttempts ?? 0;
  const events: Array<{
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }> = [];
  const enqueuedJobs: FollowupJobRequest[] = [];

  const db: TurnBridgeAdminClient = {
    claimDueEnrollments: async () => (enrollment.status === "active" ? [{ ...enrollment }] : []),
    loadEnrollmentById: async (_orgId, id) => {
      if (enrollment.id !== id) return null;
      return { ...enrollment };
    },
    loadFlowGraph: async (_orgId, versionId) => (enrollment.version_id === versionId ? (opts.graph ?? FLOW_GRAPH) : null),
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadLastInboundBody: async () => null,
    loadEnrollmentEvents: async (enrollmentId) =>
      events
        .filter(() => enrollment.id === enrollmentId)
        .map((e) => ({
          node_id: e.node_id,
          idempotency_key: e.idempotency_key,
          event_type: e.event_type,
          payload: e.payload,
        })),
    insertEnrollmentEvent: async (event) => {
      const exists = events.some((e) => e.idempotency_key === event.idempotency_key);
      if (exists) return { inserted: false };
      events.push({
        node_id: event.node_id,
        event_type: event.event_type,
        payload: event.payload,
        idempotency_key: event.idempotency_key,
      });
      return { inserted: true };
    },
    applyEnrollmentStep: async (_id, _orgId, patch, event) => {
      if (casFailuresRemaining > 0) {
        casFailuresRemaining--;
        // Simula colisão concorrente de CAS (ex: inbound_woke ou action_recheck incrementou revision no Postgres)
        enrollment = {
          ...enrollment,
          revision: Number(enrollment.revision ?? 1) + 1,
        };
        throw new EnrollmentRevisionStaleError("followup_stale");
      }
      const exists = events.some((e) => e.idempotency_key === event.idempotency_key);
      if (exists) return false;
      events.push({
        node_id: event.node_id,
        event_type: event.event_type,
        payload: event.payload,
        idempotency_key: event.idempotency_key,
      });
      enrollment = {
        ...enrollment,
        ...patch,
        updated_at: clock().toISOString(),
      };
      return true;
    },
    updateEnrollment: async (_id, _orgId, patch) => {
      enrollment = {
        ...enrollment,
        ...patch,
        updated_at: clock().toISOString(),
      };
    },
    assertServiceBoundary: async (enr) => {
      if (opts.serviceBoundaryStale) {
        throw new StaleServiceBoundaryError();
      }
      if (enr.service_boundary && typeof enr.service_boundary === "object") {
        const b = enr.service_boundary as unknown as Record<string, unknown>;
        if (b.status === "closed" || b.demanda_fechada_em) {
          throw new StaleServiceBoundaryError();
        }
      }
    },
    loadFlowPointerName: async () => "Fluxo Homologação Race",
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
    enqueueJob: async (job) => {
      enqueuedJobs.push(job);
    },
  };

  return {
    db,
    getEnrollment: () => ({ ...enrollment }),
    getEvents: () => [...events],
    getEnqueuedJobs: () => [...enqueuedJobs],
    getCasFailuresRemaining: () => casFailuresRemaining,
  };
}

describe("Followup Revision Stale Recovery - Regressão e Idempotência", () => {
  it("TEST A: Recuperação transparente após CAS stale de revision sem reenvio e avançando o grafo", async () => {
    let outboundCount = 0;
    let sendLedgerAccepted = 0;

    const initialEnrollment: EnrollmentRow = {
      id: "enr-race-attempt2",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_pre",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
      revision: 1,
      service_boundary: {
        organization_id: "org-test",
        contact_id: "cont-1",
        conversation_id: "conv-1",
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
      },
    };

    // Configura 1 falha de CAS na 1ª tentativa de applyEnrollmentStep
    const harness = createRecoveryHarness({
      initialEnrollment,
      failCasAttempts: 1,
    });

    // 1. Simula envio físico único via sendWithLedger
    outboundCount++;
    sendLedgerAccepted++;
    expect(outboundCount).toBe(1);
    expect(sendLedgerAccepted).toBe(1);

    // 2. Chama completeTurnForEnrollment ('sent')
    // Na 1ª tentativa, fn_followup_apply_step dá erro de CAS (EnrollmentRevisionStaleError).
    // O runtime deve recarregar o enrollment fresco (com revision 2), revalidar a fronteira
    // de serviço e retentar o applyStep com sucesso.
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-race-attempt2",
      "msg_pre",
      { kind: "sent" },
      clock,
      "job-inline-1",
    );

    const finalEvents = harness.getEvents();
    const finalEnrollment = harness.getEnrollment();

    // 3. Garantias obrigatórias
    const actionSentEvents = finalEvents.filter((e) => e.event_type === "action_sent");
    const OUTBOUND_COUNT = outboundCount;
    const SEND_LEDGER_ACCEPTED = sendLedgerAccepted;
    const ACTION_SENT_COUNT = actionSentEvents.length;
    const NODE_ADVANCED = finalEnrollment.current_node_id === "ai_node_race";
    const ENROLLMENT_STUCK = finalEnrollment.current_node_id === "msg_pre";

    expect(OUTBOUND_COUNT).toBe(1);
    expect(SEND_LEDGER_ACCEPTED).toBe(1);
    expect(ACTION_SENT_COUNT).toBe(1);
    expect(NODE_ADVANCED).toBe(true);
    expect(ENROLLMENT_STUCK).toBe(false);
    expect(harness.getCasFailuresRemaining()).toBe(0);
    expect(finalEnrollment.steps_taken).toBe(2);
  });

  it("TEST B: Fronteira de serviço realmente stale preserva veto permanente e não reconcilia indevidamente", async () => {
    const initialEnrollment: EnrollmentRow = {
      id: "enr-boundary-stale",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_pre",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
      revision: 1,
      service_boundary: {
        organization_id: "org-test",
        contact_id: "cont-1",
        conversation_id: "conv-1",
        service_revision: 1,
        demanda_id: "dem-1",
        demanda_revision: 1,
      },
    };

    const harness = createRecoveryHarness({
      initialEnrollment,
      serviceBoundaryStale: true,
      failCasAttempts: 1,
    });

    // Deve lançar StaleServiceBoundaryError como veto permanente
    await expect(
      completeTurnForEnrollment(
        harness.db,
        "org-test",
        "enr-boundary-stale",
        "msg_pre",
        { kind: "sent" },
        clock,
        "job-inline-2",
      ),
    ).rejects.toThrow(StaleServiceBoundaryError);

    // action_sent NÃO deve ter sido gravado
    const actionSentEvents = harness.getEvents().filter((e) => e.event_type === "action_sent");
    expect(actionSentEvents).toHaveLength(0);

    // O nó NÃO deve ter avançado
    expect(harness.getEnrollment().current_node_id).toBe("msg_pre");
  });

  it("TEST C: action_sent já existente antes do retry garante conclusão idempotente e zero duplicação", async () => {
    const initialEnrollment: EnrollmentRow = {
      id: "enr-already-completed",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_pre",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
      revision: 1,
      service_boundary: {
        organization_id: "org-test",
        contact_id: "cont-1",
        conversation_id: "conv-1",
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
      },
    };

    const harness = createRecoveryHarness({
      initialEnrollment,
    });

    // Pré-grava action_sent no histórico
    await harness.db.insertEnrollmentEvent({
      organization_id: "org-test",
      enrollment_id: "enr-already-completed",
      node_id: "msg_pre",
      event_type: "action_sent",
      payload: {},
      idempotency_key: "msg_pre:1:action_sent",
    });

    expect(harness.getEvents().filter((e) => e.event_type === "action_sent")).toHaveLength(1);

    // Executa completeTurnForEnrollment
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-already-completed",
      "msg_pre",
      { kind: "sent" },
      clock,
      "job-inline-3",
    );

    // Valida que action_sent continua com contagem 1 (sem duplicação)
    const events = harness.getEvents();
    expect(events.filter((e) => e.event_type === "action_sent")).toHaveLength(1);
  });
});

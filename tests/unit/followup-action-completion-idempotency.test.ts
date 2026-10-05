import { describe, it, expect } from "vitest";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { FollowupJobRequest } from "@/lib/followup/engine";
import { runFollowupTick } from "@/lib/followup/engine";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const clock = () => NOW;

function createTestHarness(initialEnrollment: EnrollmentRow, graph: FlowGraph) {
  let enrollment = { ...initialEnrollment };
  const events: Array<{
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }> = [];
  const enqueuedJobs: FollowupJobRequest[] = [];

  const db: TurnBridgeAdminClient = {
    claimDueEnrollments: async () => (enrollment.status === "active" ? [{ ...enrollment }] : []),
    loadEnrollmentById: async (_orgId, id) => (enrollment.id === id ? { ...enrollment } : null),
    loadFlowGraph: async (_orgId, versionId) => (enrollment.version_id === versionId ? graph : null),
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
      // Simula a constraint UNIQUE (enrollment_id, idempotency_key) do Postgres
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
    updateEnrollment: async (_id, _orgId, patch) => {
      enrollment = {
        ...enrollment,
        ...patch,
        updated_at: clock().toISOString(),
      };
    },
    loadFlowPointerName: async () => "Fluxo Teste",
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
  };
}

describe("Followup action completion idempotency - reprodução e correção", () => {
  const MSG_TO_END_GRAPH: FlowGraph = {
    nodes: [
      {
        id: "msg_custom_completed",
        type: "message_text",
        label: "Mensagem Final",
        position: { x: 0, y: 0 },
        config: { body: "CUSTOM PROMPT CONCLUÍDO — FLUXO CONTINUOU" },
      },
      {
        id: "end_custom",
        type: "end",
        label: "Fim Custom",
        position: { x: 0, y: 100 },
        config: { outcome: "custom", note: "e2e_custom_prompt_completed" },
      },
    ],
    edges: [
      {
        id: "e-msg-end",
        source: "msg_custom_completed",
        target: "end_custom",
        priority: 0,
        condition: { type: "always" },
      },
    ],
  };

  it("REPRODUÇÃO: turn_enqueued e action_sent coexistem com chaves diferentes e avançam até o end", async () => {
    const initialEnrollment: EnrollmentRow = {
      id: "enr-test-1",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_custom_completed",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 6,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
    };

    const harness = createTestHarness(initialEnrollment, MSG_TO_END_GRAPH);

    // 1. Simula o engine gravando o evento de turn_enqueued no formato <node_id>:<steps_taken>
    await harness.db.insertEnrollmentEvent({
      organization_id: "org-test",
      enrollment_id: "enr-test-1",
      node_id: "msg_custom_completed",
      event_type: "turn_enqueued",
      payload: {},
      idempotency_key: "msg_custom_completed:6",
    });

    // 2. Callback de conclusão do worker entrega 'sent'
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-test-1",
      "msg_custom_completed",
      { kind: "sent" },
      clock,
      "job-123",
    );

    const events = harness.getEvents();
    const finalEnrollment = harness.getEnrollment();

    // 3. Valida que turn_enqueued e action_sent coexistem com chaves diferentes
    const turnEnqueued = events.filter((e) => e.event_type === "turn_enqueued");
    const actionSent = events.filter((e) => e.event_type === "action_sent");

    expect(turnEnqueued).toHaveLength(1);
    expect(actionSent).toHaveLength(1);

    expect(turnEnqueued[0]!.idempotency_key).toBe("msg_custom_completed:6");
    expect(actionSent[0]!.idempotency_key).toBe("msg_custom_completed:6:action_sent");
    expect(turnEnqueued[0]!.idempotency_key).not.toBe(actionSent[0]!.idempotency_key);

    // 4. Valida que o enrollment avançou para o próximo nó (end_custom) e terminou o fluxo
    expect(finalEnrollment.current_node_id).toBe("end_custom");
    expect(finalEnrollment.status).toBe("completed");
    expect(finalEnrollment.outcome).toBeNull();
    expect(finalEnrollment.cancel_reason).toBe("e2e_custom_prompt_completed");

    // 5. Valida o encadeamento de eventos até o flow_completed
    const flowCompleted = events.filter((e) => e.event_type === "flow_completed");
    expect(flowCompleted).toHaveLength(1);
  });

  it("RETRY IDEMPOTENTE: replay do mesmo callback de conclusão não duplica action_sent nem re-avança", async () => {
    const initialEnrollment: EnrollmentRow = {
      id: "enr-test-retry",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_custom_completed",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 6,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
    };

    const harness = createTestHarness(initialEnrollment, MSG_TO_END_GRAPH);

    // Enqueue inicial
    await harness.db.insertEnrollmentEvent({
      organization_id: "org-test",
      enrollment_id: "enr-test-retry",
      node_id: "msg_custom_completed",
      event_type: "turn_enqueued",
      payload: {},
      idempotency_key: "msg_custom_completed:6",
    });

    // 1ª Conclusão
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-test-retry",
      "msg_custom_completed",
      { kind: "sent" },
      clock,
      "job-123",
    );

    const eventsAfterFirst = harness.getEvents();
    const enrollmentAfterFirst = harness.getEnrollment();
    expect(eventsAfterFirst.filter((e) => e.event_type === "action_sent")).toHaveLength(1);

    // 2ª Conclusão (Retry do mesmo job após ack perdido)
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-test-retry",
      "msg_custom_completed",
      { kind: "sent" },
      clock,
      "job-123",
    );

    const eventsAfterRetry = harness.getEvents();
    const enrollmentAfterRetry = harness.getEnrollment();

    // Zero duplicação
    expect(eventsAfterRetry.filter((e) => e.event_type === "action_sent")).toHaveLength(1);
    expect(enrollmentAfterRetry.steps_taken).toBe(enrollmentAfterFirst.steps_taken);
    expect(enrollmentAfterRetry.current_node_id).toBe(enrollmentAfterFirst.current_node_id);
    expect(enrollmentAfterRetry.status).toBe(enrollmentAfterFirst.status);
  });

  it("OUTROS RESULT KINDS: skipped, classified, planned usam chaves qualificadas por event_type", async () => {
    const MULTI_GRAPH: FlowGraph = {
      nodes: [
        { id: "t1", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        {
          id: "w1",
          type: "wait",
          label: "Wait",
          position: { x: 0, y: 50 },
          config: { mode: "smart", min_ms: 60000, max_ms: 180000 },
        },
        {
          id: "ac1",
          type: "ai_classify",
          label: "Classify",
          position: { x: 0, y: 100 },
          config: { classes: ["sim", "nao"], grace_timeout_ms: 900000, target: "last_reply" },
        },
        {
          id: "msg1",
          type: "message_text",
          label: "Msg",
          position: { x: 0, y: 150 },
          config: { body: "Texto" },
        },
        { id: "e1", type: "end", label: "End", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e-t-w", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
        { id: "e-w-ac", source: "w1", target: "ac1", priority: 0, condition: { type: "always" } },
        { id: "e-ac-msg", source: "ac1", target: "msg1", priority: 0, condition: { type: "class_match", value: "sim" } },
        { id: "e-msg-e", source: "msg1", target: "e1", priority: 0, condition: { type: "always" } },
      ],
    };

    // Teste para 'planned' -> timing_plan_decidido
    const hPlanned = createTestHarness(
      {
        id: "enr-planned",
        organization_id: "org-1",
        pointer_id: "ptr-1",
        version_id: "ver-1",
        contact_id: "c-1",
        conversation_id: "conv-1",
        current_node_id: "t1",
        status: "active",
        next_eval_at: NOW.toISOString(),
        claimed_until: null,
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        steps_taken: 2,
        outcome: null,
        cancel_reason: null,
        started_at: NOW.toISOString(),
        completed_at: null,
        updated_at: NOW.toISOString(),
      },
      MULTI_GRAPH,
    );
    await completeTurnForEnrollment(
      hPlanned.db,
      "org-1",
      "enr-planned",
      "t1",
      {
        kind: "planned",
        modelo: "anthropic/claude-sonnet-4-6",
        propostas: [{ node_id: "w1", aguardar_ms: 90000, motivo: "teste" }],
      },
      clock,
      "job-plan",
    );
    expect(hPlanned.getEvents()).toContainEqual(
      expect.objectContaining({
        event_type: "timing_plan_decidido",
        idempotency_key: "t1:2:timing_plan_decidido",
      }),
    );

    // Teste para 'classified' -> ai_classified
    const hClassified = createTestHarness(
      {
        id: "enr-classified",
        organization_id: "org-1",
        pointer_id: "ptr-1",
        version_id: "ver-1",
        contact_id: "c-1",
        conversation_id: "conv-1",
        current_node_id: "ac1",
        status: "active",
        next_eval_at: NOW.toISOString(),
        claimed_until: null,
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        steps_taken: 3,
        outcome: null,
        cancel_reason: null,
        started_at: NOW.toISOString(),
        completed_at: null,
        updated_at: NOW.toISOString(),
      },
      MULTI_GRAPH,
    );
    await completeTurnForEnrollment(
      hClassified.db,
      "org-1",
      "enr-classified",
      "ac1",
      { kind: "classified", class: "sim" },
      clock,
      "job-class",
    );
    expect(hClassified.getEvents()).toContainEqual(
      expect.objectContaining({
        event_type: "ai_classified",
        idempotency_key: "ac1:3:ai_classified",
      }),
    );

    // Teste para 'skipped' -> turn_skipped
    const hSkipped = createTestHarness(
      {
        id: "enr-skipped",
        organization_id: "org-1",
        pointer_id: "ptr-1",
        version_id: "ver-1",
        contact_id: "c-1",
        conversation_id: "conv-1",
        current_node_id: "msg1",
        status: "active",
        next_eval_at: NOW.toISOString(),
        claimed_until: null,
        attempts: 0,
        max_attempts: 5,
        last_error: null,
        steps_taken: 4,
        outcome: null,
        cancel_reason: null,
        started_at: NOW.toISOString(),
        completed_at: null,
        updated_at: NOW.toISOString(),
      },
      MULTI_GRAPH,
    );
    await completeTurnForEnrollment(
      hSkipped.db,
      "org-1",
      "enr-skipped",
      "msg1",
      { kind: "skipped", reason: "opt_out_detectado" },
      clock,
      "job-skip",
    );
    expect(hSkipped.getEvents()).toContainEqual(
      expect.objectContaining({
        event_type: "turn_skipped",
        idempotency_key: "msg1:4:turn_skipped",
      }),
    );
    expect(hSkipped.getEnrollment().status).toBe("cancelled");
    expect(hSkipped.getEnrollment().cancel_reason).toBe("opt_out_detectado");
  });

  it("STALE CALLBACK: callback de nó anterior não avança enrollment que já mudou de nó", async () => {
    const initialEnrollment: EnrollmentRow = {
      id: "enr-stale",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "end_custom", // enrollment já está no end
      status: "completed",
      next_eval_at: null,
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 7,
      outcome: null,
      cancel_reason: "e2e_custom_prompt_completed",
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };

    const harness = createTestHarness(initialEnrollment, MSG_TO_END_GRAPH);

    // Chega callback tardio referenciando 'msg_custom_completed'
    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-stale",
      "msg_custom_completed",
      { kind: "sent" },
      clock,
      "job-old",
    );

    expect(harness.getEvents()).toHaveLength(0);
    expect(harness.getEnrollment().current_node_id).toBe("end_custom");
    expect(harness.getEnrollment().status).toBe("completed");
  });

  it("CASO REGRESSÃO B: action_recheck após action_sent válido não entra em loop (avança imediatamente)", async () => {
    const STEP_GRAPH: FlowGraph = {
      nodes: [
        {
          id: "msg_step",
          type: "message_text",
          label: "Mensagem Step",
          position: { x: 0, y: 0 },
          config: { body: "Olá" },
        },
        {
          id: "end_step",
          type: "end",
          label: "Fim Step",
          position: { x: 0, y: 100 },
          config: { outcome: "converted" },
        },
      ],
      edges: [
        {
          id: "e-step",
          source: "msg_step",
          target: "end_step",
          priority: 0,
          condition: { type: "always" },
        },
      ],
    };

    const initialEnrollment: EnrollmentRow = {
      id: "enr-recheck",
      organization_id: "org-test",
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      current_node_id: "msg_step",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 2,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
    };

    const harness = createTestHarness(initialEnrollment, STEP_GRAPH);

    // Simula que action_sent já foi registrado no banco
    await harness.db.insertEnrollmentEvent({
      organization_id: "org-test",
      enrollment_id: "enr-recheck",
      node_id: "msg_step",
      event_type: "action_sent",
      payload: {},
      idempotency_key: "msg_step:2:action_sent",
    });

    // 1º tick avança de msg_step para end_step (sara a corrida com recheck e avança imediatamente)
    const summary1 = await runFollowupTick(
      { db: harness.db, clock, enqueueJob: harness.db.enqueueJob ?? (async () => {}) },
      { limit: 1 },
    );
    expect(summary1.advanced).toBe(1);
    expect(harness.getEnrollment().current_node_id).toBe("end_step");

    // 2º tick avalia o nó terminal end_step e conclui o enrollment
    await runFollowupTick(
      { db: harness.db, clock, enqueueJob: harness.db.enqueueJob ?? (async () => {}) },
      { limit: 1 },
    );
    expect(harness.getEnrollment().status).toBe("completed");
    expect(harness.getEnrollment().outcome).toBe("converted");
  });
});

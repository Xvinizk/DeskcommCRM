import { describe, it, expect } from "vitest";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { FollowupJobRequest } from "@/lib/followup/engine";
import { EnrollmentRevisionStaleError, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const NOW = new Date("2026-10-04T14:18:00.000Z");
const clock = () => NOW;

const GRAPH_AI_MSG_END: FlowGraph = {
  nodes: [
    {
      id: "node_ai_1",
      type: "ai_node",
      label: "Node IA",
      position: { x: 0, y: 0 },
      config: {
        mode: "custom_prompt",
        custom_prompt: "Teste",
        timeout: { duration_value: 15, unit: "minutes" },
        timeout_ms: 900_000,
      },
    },
    {
      id: "msg_completed",
      type: "message_text",
      label: "Mensagem Concluída",
      position: { x: 0, y: 100 },
      config: { body: "FINAL-REG-CUSTOM COMPLETED OK" },
    },
    {
      id: "end_completed",
      type: "end",
      label: "Fim Concluído",
      position: { x: 0, y: 200 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    {
      id: "e_ai_msg",
      source: "node_ai_1",
      target: "msg_completed",
      priority: 0,
      condition: { type: "branch", branch_id: "completed" },
    },
    {
      id: "e_msg_end",
      source: "msg_completed",
      target: "end_completed",
      priority: 0,
      condition: { type: "always" },
    },
  ],
};

const GRAPH_CLASSIFY_MSG_END: FlowGraph = {
  nodes: [
    {
      id: "classify_1",
      type: "ai_classify",
      label: "Classificador",
      position: { x: 0, y: 0 },
      config: {
        classes: ["sucesso", "duvida"],
        grace_timeout_ms: 900_000,
        target: "last_reply",
      },
    },
    {
      id: "msg_sucesso",
      type: "message_text",
      label: "Mensagem Sucesso",
      position: { x: 0, y: 100 },
      config: { body: "CLASSIFICADO COM SUCESSO" },
    },
    {
      id: "end_sucesso",
      type: "end",
      label: "Fim",
      position: { x: 0, y: 200 },
      config: { outcome: "converted" },
    },
  ],
  edges: [
    {
      id: "e_cls_msg",
      source: "classify_1",
      target: "msg_sucesso",
      priority: 0,
      condition: { type: "class_match", value: "sucesso" },
    },
    {
      id: "e_msg_end",
      source: "msg_sucesso",
      target: "end_sucesso",
      priority: 0,
      condition: { type: "always" },
    },
  ],
};

function createInlineRevisionHarness(opts: {
  initialRevision?: number;
  graph?: FlowGraph;
  initialNodeId?: string;
  serviceBoundaryClosed?: boolean;
}) {
  let dbRevision = opts.initialRevision ?? 1;
  const revisionsMap = new Map<string, number>();

  let enrollment: EnrollmentRow = {
    id: "enr-inline-revision-test",
    organization_id: "org-test",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "cont-1",
    conversation_id: "conv-1",
    current_node_id: opts.initialNodeId ?? "msg_completed",
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
    revision: dbRevision,
    service_boundary: {
      organization_id: "org-test",
      contact_id: "cont-1",
      conversation_id: "conv-1",
      service_revision: 1,
      demanda_id: "dem-1",
      demanda_revision: 1,
    },
  };

  revisionsMap.set(enrollment.id, dbRevision);

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
      const cur = revisionsMap.get(id);
      if (cur === undefined || dbRevision > cur) {
        revisionsMap.set(id, dbRevision);
      }
      return { ...enrollment, revision: dbRevision };
    },
    loadFlowGraph: async (_orgId, versionId) => (enrollment.version_id === versionId ? (opts.graph ?? GRAPH_AI_MSG_END) : null),
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
    applyEnrollmentStep: async (id, _orgId, patch, event) => {
      const currentMapRev = revisionsMap.get(id);
      if (currentMapRev === undefined || currentMapRev !== dbRevision) {
        throw new EnrollmentRevisionStaleError(
          `applyStep CAS failed: map revision ${currentMapRev} != db revision ${dbRevision}`
        );
      }

      dbRevision += 1;
      revisionsMap.set(id, dbRevision);

      events.push({
        node_id: event.node_id,
        event_type: event.event_type,
        payload: event.payload,
        idempotency_key: event.idempotency_key,
      });

      enrollment = {
        ...enrollment,
        ...patch,
        revision: dbRevision,
        updated_at: clock().toISOString(),
      };
      return true;
    },
    updateEnrollment: async (id, _orgId, patch) => {
      const currentMapRev = revisionsMap.get(id);
      if (currentMapRev === undefined || currentMapRev !== dbRevision) {
        throw new EnrollmentRevisionStaleError(
          `updateEnrollment CAS failed: map revision ${currentMapRev} != db revision ${dbRevision}`
        );
      }

      dbRevision += 1;
      revisionsMap.set(id, dbRevision);

      enrollment = {
        ...enrollment,
        ...patch,
        revision: dbRevision,
        updated_at: clock().toISOString(),
      };
    },
    assertServiceBoundary: async (enr) => {
      if (opts.serviceBoundaryClosed) {
        throw new StaleServiceBoundaryError();
      }
      if (enr.revision !== undefined) {
        const cur = revisionsMap.get(enr.id);
        const inc = Number(enr.revision);
        if (cur === undefined || inc > cur) {
          revisionsMap.set(enr.id, inc);
        }
      }
    },
    loadFlowPointerName: async () => "Fluxo AI Msg End",
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
    getDbRevision: () => dbRevision,
    getRevisionsMap: () => new Map(revisionsMap),
    getEnqueuedJobs: () => [...enqueuedJobs],
  };
}

describe("Followup Inline Post-Step Revision - Testes Obrigatórios", () => {
  it("A. message_text com avanço inline para end_completed preserva revision e completa com sucesso", async () => {
    const harness = createInlineRevisionHarness({ initialRevision: 5 });

    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-inline-revision-test",
      "msg_completed",
      { kind: "sent" },
      clock,
      "job-1",
    );

    const enr = harness.getEnrollment();
    expect(enr.status).toBe("completed");
    expect(enr.current_node_id).toBe("end_completed");
    expect(enr.outcome).toBe("converted");
    expect(enr.revision).toBe(7); // 5 -> 6 (msg_completed) -> 7 (end_completed)

    // Confirma que eventos foram gravados na ordem exata
    const events = harness.getEvents();
    expect(events.map((e) => e.event_type)).toEqual(["action_sent", "flow_completed"]);
  });

  it("B. ai_classify com avanço inline para message_text preserva revision atualizada", async () => {
    const harness = createInlineRevisionHarness({
      initialRevision: 10,
      graph: GRAPH_CLASSIFY_MSG_END,
      initialNodeId: "classify_1",
    });

    await completeTurnForEnrollment(
      harness.db,
      "org-test",
      "enr-inline-revision-test",
      "classify_1",
      { kind: "classified", class: "sucesso" },
      clock,
      "job-cls-1",
    );

    const enr = harness.getEnrollment();
    // classify_1 avança para msg_sucesso (que é isSendMessageNode e enfileira turno de envio)
    expect(enr.current_node_id).toBe("msg_sucesso");
    expect(enr.status).toBe("active");
    expect(enr.revision).toBe(12); // 10 -> 11 (classify_1 applyStep) -> 12 (msg_sucesso enqueue_turn)

    const jobs = harness.getEnqueuedJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.payload.node_id).toBe("msg_sucesso");
  });

  it("C. Cache de revision é monotônico e nunca regride de N+1 para N no assertServiceBoundary", async () => {
    const harness = createInlineRevisionHarness({ initialRevision: 3 });

    // assertServiceBoundary inicial: cache = 3
    await harness.db.assertServiceBoundary?.({
      ...harness.getEnrollment(),
      revision: 3,
    });
    expect(harness.getRevisionsMap().get("enr-inline-revision-test")).toBe(3);

    // applyStep avança revision para 4
    await harness.db.applyEnrollmentStep?.(
      "enr-inline-revision-test",
      "org-test",
      { current_node_id: "end_completed" },
      { node_id: "msg_completed", event_type: "action_sent", payload: {}, idempotency_key: "step-1" },
    );
    expect(harness.getRevisionsMap().get("enr-inline-revision-test")).toBe(4);

    // assertServiceBoundary chamado com objeto stale (revision 3) NÃO deve regredir cache para 3
    await harness.db.assertServiceBoundary?.({
      ...harness.getEnrollment(),
      revision: 3,
    });
    expect(harness.getRevisionsMap().get("enr-inline-revision-test")).toBe(4);

    // updateEnrollment subsequente com revision 4 deve ter sucesso sem CAS error
    await harness.db.updateEnrollment(
      "enr-inline-revision-test",
      "org-test",
      { status: "completed" },
    );
    expect(harness.getRevisionsMap().get("enr-inline-revision-test")).toBe(5);
  });

  it("D. Fronteira de atendimento stale real continua disparando StaleServiceBoundaryError (fail-closed)", async () => {
    const harness = createInlineRevisionHarness({
      initialRevision: 1,
      serviceBoundaryClosed: true,
    });

    await expect(
      completeTurnForEnrollment(
        harness.db,
        "org-test",
        "enr-inline-revision-test",
        "msg_completed",
        { kind: "sent" },
        clock,
        "job-closed",
      ),
    ).rejects.toThrow(StaleServiceBoundaryError);
  });
});

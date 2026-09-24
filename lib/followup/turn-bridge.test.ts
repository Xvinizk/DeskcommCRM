import { describe, it, expect, vi } from "vitest";

import { completeTurnForEnrollment, createPgAdminClient, type TurnBridgeAdminClient } from "./turn-bridge";
import type { EnrollmentRow, EnrollmentEventRef } from "./node-handlers";
import type { FlowGraph } from "./graph-schema";
import type { FollowupJobRequest } from "./engine";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const clock = () => NOW;

function enrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "a1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: NOW.toISOString(),
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

const ACTION_GRAPH: FlowGraph = {
  nodes: [
    { id: "a1", type: "action", label: "Send", position: { x: 0, y: 0 }, config: { mode: "ai_message", prompt_hint: "oi" } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const CLASSIFY_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    },
    { id: "hot-node", type: "end", label: "Hot", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    { id: "fallback-node", type: "end", label: "Fallback", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "ac1-hot", source: "ac1", target: "hot-node", priority: 5, condition: { type: "class_match", value: "hot" } },
    { id: "ac1-fallback", source: "ac1", target: "fallback-node", priority: 0, condition: { type: "always" } },
  ],
};

/** Acionamento → duas esperas adaptativas: o plano decide as DUAS de uma vez. */
const PLAN_GRAPH: FlowGraph = {
  nodes: [
    { id: "t1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "w1",
      type: "wait",
      label: "Primeira espera",
      position: { x: 0, y: 0 },
      config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000 },
    },
    {
      id: "w2",
      type: "wait",
      label: "Segunda espera",
      position: { x: 0, y: 0 },
      config: { mode: "smart", min_ms: 3_600_000, max_ms: 86_400_000 },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "t1-w1", source: "t1", target: "w1", priority: 0, condition: { type: "always" } },
    { id: "w1-w2", source: "w1", target: "w2", priority: 0, condition: { type: "always" } },
    { id: "w2-e1", source: "w2", target: "e1", priority: 0, condition: { type: "always" } },
  ],
};

/** Fake in-memory TurnBridgeAdminClient — mirrors the pg-backed adapter's contract without a DB. */
function fakeDb(opts: {
  enrollment: EnrollmentRow | null;
  graph: FlowGraph | null;
  existingEvents?: Set<string>;
}): { db: TurnBridgeAdminClient; updateEnrollment: ReturnType<typeof vi.fn>; insertEnrollmentEvent: ReturnType<typeof vi.fn> } {
  const eventKeys = opts.existingEvents ?? new Set<string>();
  const updateEnrollment = vi.fn(async () => {});
  const insertEnrollmentEvent = vi.fn(async (event: { idempotency_key: string }) => {
    if (eventKeys.has(event.idempotency_key)) return { inserted: false };
    eventKeys.add(event.idempotency_key);
    return { inserted: true };
  });
  const db: TurnBridgeAdminClient = {
    claimDueEnrollments: async () => [],
    loadEnrollmentById: async () => opts.enrollment,
    loadFlowGraph: async () => opts.graph,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadLastInboundBody: async () => null,
    loadEnrollmentEvents: async () => [],
    insertEnrollmentEvent,
    updateEnrollment,
    loadFlowPointerName: async () => null,
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
  };
  return { db, updateEnrollment, insertEnrollmentEvent };
}

describe("completeTurnForEnrollment — 'sent' (action)", () => {
  it("advances to the next node via the 'always' edge and writes an idempotent 'action_sent' event", async () => {
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment(), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "a1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("double completion (same steps_taken) is idempotent — 2nd call is a no-op", async () => {
    const { db, updateEnrollment } = fakeDb({
      enrollment: enrollment(),
      graph: ACTION_GRAPH,
      existingEvents: new Set(["a1:4"]),
    });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("throws when the node isn't an 'action' node or other message sending node", async () => {
    const { db } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });
    await expect(completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "sent" }, clock)).rejects.toThrow();
  });

  it("advances message_text node via 'always' edge upon 'sent' result", async () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "mt1", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Olá" } },
        { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "mt1-e1", source: "mt1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment({ current_node_id: "mt1" }), graph });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "mt1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "mt1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("advances message_image node via 'always' edge upon 'sent' result", async () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "mi1", type: "message_image", label: "Imagem", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/img.jpg" } },
        { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "mi1-e1", source: "mi1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment({ current_node_id: "mi1" }), graph });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "mi1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "mi1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("advances message_video node via 'always' edge upon 'sent' result", async () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "mv1", type: "message_video", label: "Vídeo", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/video.mp4" } },
        { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "mv1-e1", source: "mv1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment({ current_node_id: "mv1" }), graph });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "mv1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "mv1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("advances message_audio node via 'always' edge upon 'sent' result", async () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "ma1", type: "message_audio", label: "Áudio", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/audio.ogg" } },
        { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [{ id: "ma1-e1", source: "ma1", target: "e1", priority: 0, condition: { type: "always" } }],
    };
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment({ current_node_id: "ma1" }), graph });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ma1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "ma1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("match_reply + sent is a no-op — the confirm question already parked waiting_reply", async () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: "m_name",
          type: "match_reply",
          label: "Nome",
          position: { x: 0, y: 0 },
          config: {
            branches: [{ id: "ok", label: "Ok", op: "eq", pattern: "sim" }],
            grace_timeout_ms: 900_000,
            save_to: { kind: "contact_name" },
            if_exists: "confirm",
          },
        },
      ],
      edges: [{ id: "m-end", source: "m_name", target: "m_name", priority: 0, condition: { type: "always" } }],
    };
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({
      enrollment: enrollment({ current_node_id: "m_name", status: "waiting_reply" }),
      graph,
    });
    await completeTurnForEnrollment(db, "org-1", "enr-1", "m_name", { kind: "sent" }, clock);
    expect(updateEnrollment).not.toHaveBeenCalled();
    expect(insertEnrollmentEvent).not.toHaveBeenCalled();
  });
});

describe("completeTurnForEnrollment — 'classified' (ai_classify)", () => {
  it("routes to the exact class_match edge", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "classified", class: "hot" }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "hot-node" }),
    );
  });

  /**
   * Nó já migrado para ramos nomeados: a aresta referencia o id ESTÁVEL do ramo,
   * não o texto da classe. Resolver por texto aqui não acha aresta nenhuma e cai
   * no fallback — o lead classificado como "quente" iria para o mesmo lugar de
   * quem não foi classificado, sem erro nenhum aparecer. Renomear a classe passa
   * a ser seguro exatamente porque a aresta não depende do nome.
   */
  it("nó com ramos nomeados: a classe conhecida vai pelo RAMO dela, não pelo fallback", async () => {
    const grafoV2: FlowGraph = {
      nodes: [
        {
          id: "ac1",
          type: "ai_classify",
          label: "Classify",
          position: { x: 0, y: 0 },
          config: {
            classes: ["quente", "frio"],
            branches: [
              { id: "br_quente", label: "quente" },
              { id: "br_frio", label: "frio" },
            ],
            grace_timeout_ms: 900_000,
            target: "last_reply",
          },
        },
        { id: "no-quente", type: "end", label: "Quente", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
        { id: "escape", type: "end", label: "Escape", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e-quente", source: "ac1", target: "no-quente", priority: 5, condition: { type: "branch", branch_id: "br_quente" } },
        { id: "e-escape", source: "ac1", target: "escape", priority: 0, condition: { type: "always" } },
      ],
    };
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: grafoV2 });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "classified", class: "quente" }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "no-quente" }),
    );
  });

  it("routes an unknown class through the 'always' fallback edge", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "classified", class: "mystery" }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "fallback-node" }),
    );
  });
});

describe("completeTurnForEnrollment — 'planned' (acionamento, no trigger)", () => {
  const noTrigger = () => enrollment({ current_node_id: "t1" });

  it("grava o plano das DUAS esperas e sai do trigger para o 1º nó", async () => {
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: noTrigger(), graph: PLAN_GRAPH });

    await completeTurnForEnrollment(
      db,
      "org-1",
      "enr-1",
      "t1",
      {
        kind: "planned",
        modelo: "anthropic/claude-sonnet-4-6",
        propostas: [
          { node_id: "w1", aguardar_ms: 900_000, motivo: "lead engajado, retomar no mesmo dia" },
          { node_id: "w2", aguardar_ms: 7_200_000, motivo: "segunda tentativa pode respirar mais" },
        ],
      },
      clock,
    );

    const patch = updateEnrollment.mock.calls[0]![2] as { timing_plan: { esperas: Record<string, unknown> } };
    expect(patch).toMatchObject({ current_node_id: "w1", status: "active" });
    expect(patch.timing_plan.esperas).toEqual({
      w1: {
        escolhido_ms: 900_000,
        min_ms: 600_000,
        max_ms: 1_800_000,
        proposto_ms: 900_000,
        clampado: false,
        motivo: "lead engajado, retomar no mesmo dia",
      },
      w2: {
        escolhido_ms: 7_200_000,
        min_ms: 3_600_000,
        max_ms: 86_400_000,
        proposto_ms: 7_200_000,
        clampado: false,
        motivo: "segunda tentativa pode respirar mais",
      },
    });
    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "timing_plan_decidido", idempotency_key: "t1:4" }),
    );
  });

  it("proposta fora do intervalo do nó é grampeada e marcada — nunca aceita, nunca descartada em silêncio", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: noTrigger(), graph: PLAN_GRAPH });

    await completeTurnForEnrollment(
      db,
      "org-1",
      "enr-1",
      "t1",
      {
        kind: "planned",
        modelo: "m",
        propostas: [{ node_id: "w1", aguardar_ms: 3 * 86_400_000, motivo: "esperar 3 dias" }],
      },
      clock,
    );

    const patch = updateEnrollment.mock.calls[0]![2] as {
      timing_plan: { esperas: Record<string, { escolhido_ms: number; proposto_ms: number; clampado: boolean }> };
    };
    expect(patch.timing_plan.esperas.w1).toMatchObject({
      escolhido_ms: 1_800_000, // o máximo do nó
      proposto_ms: 3 * 86_400_000, // o que a IA pediu, preservado para o dossiê
      clampado: true,
    });
  });

  it("espera sem proposta fica FORA do plano — o nó cai no máximo, não num número inventado", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: noTrigger(), graph: PLAN_GRAPH });

    await completeTurnForEnrollment(
      db,
      "org-1",
      "enr-1",
      "t1",
      { kind: "planned", modelo: "m", propostas: [{ node_id: "w1", aguardar_ms: 900_000, motivo: "ok" }] },
      clock,
    );

    const patch = updateEnrollment.mock.calls[0]![2] as { timing_plan: { esperas: Record<string, unknown> } };
    expect(Object.keys(patch.timing_plan.esperas)).toEqual(["w1"]);
  });

  it("lança quando o nó do turno não é o trigger", async () => {
    const { db } = fakeDb({ enrollment: enrollment({ current_node_id: "w1" }), graph: PLAN_GRAPH });
    await expect(
      completeTurnForEnrollment(db, "org-1", "enr-1", "w1", { kind: "planned", modelo: "m", propostas: [] }, clock),
    ).rejects.toThrow();
  });
});

describe("completeTurnForEnrollment — obsolescência", () => {
  it("no-ops when the enrollment already moved past the node the turn ran for", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "e1" }), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("no-ops when the enrollment is already terminal", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ status: "dead" }), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("no-ops silently when the enrollment no longer exists", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: null, graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });
});


describe("callback conserva a fronteira durante a conclusão", () => {
  it.each(["classified", "planned"] as const)("%s não escreve se atendimento muda durante leitura do grafo", async (kind) => {
    const planned = kind === "planned";
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({
      enrollment: enrollment({ current_node_id: planned ? "t1" : "ac1" }),
      graph: planned ? PLAN_GRAPH : CLASSIFY_GRAPH,
    });
    let stale = false;
    db.assertServiceBoundary = async () => { if (stale) throw new Error("service_boundary_stale"); };
    const load = db.loadFlowGraph;
    db.loadFlowGraph = async (...args) => { const graph = await load(...args); stale = true; return graph; };
    await expect(completeTurnForEnrollment(db, "org-1", "enr-1", planned ? "t1" : "ac1",
      planned ? { kind: "planned", propostas: [], modelo: "test" } : { kind: "classified", class: "hot" }, clock)).rejects.toThrow("service_boundary_stale");
    expect(insertEnrollmentEvent).not.toHaveBeenCalled();
    expect(updateEnrollment).not.toHaveBeenCalled();
  });
});


it("adapter PG preserva provenance e leitor de inbound filtra a conversa solicitada", async () => {
  const boundary = { organization_id: "org-1", contact_id: "contact-1", conversation_id: "conv-1", service_revision: 2, demanda_id: null, demanda_revision: null };
  let current = { ...boundary, status: "open", demanda_fechada_em: null };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("from followup_enrollments")
    ? [{ ...enrollment(), service_boundary: boundary }] : sql.includes("from conversations c left join demandas") ? [current] : [] }));
  const db = createPgAdminClient({ query } as unknown as Parameters<typeof createPgAdminClient>[0]);
  const row = await db.loadEnrollmentById("org-1", "enr-1");
  expect(row?.service_boundary).toEqual(boundary);
  await expect(db.assertServiceBoundary!(row!)).resolves.toBeUndefined();
  current = { ...current, service_revision: 4 };
  await expect(db.assertServiceBoundary!(row!)).rejects.toThrow("service_boundary_stale");
  await db.loadLastInboundBody("org-1", "contact-1", "conv-1");
  const [sql, values] = query.mock.calls.at(-1)! as unknown as [string, unknown[]];
  expect(sql).toMatch(/conversation_id\s*=\s*\$3/);
  expect(values[2]).toBe("conv-1");
});

describe("PATH B — turn-bridge timing nodes (typing & delay)", () => {
  function createPathBHarness(opts: {
    enrollment: EnrollmentRow;
    graph: FlowGraph;
  }) {
    let currentEnrollment = { ...opts.enrollment };
    const events: EnrollmentEventRef[] = [];
    const enqueuedJobs: FollowupJobRequest[] = [];
    const signals: Array<{ presence: string }> = [];

    const db: TurnBridgeAdminClient = {
      claimDueEnrollments: async () => [currentEnrollment],
      loadEnrollmentById: async (_orgId, id) => {
        if (currentEnrollment.id === id) return { ...currentEnrollment };
        return null;
      },
      loadFlowGraph: async (_orgId, versionId) => {
        if (opts.enrollment.version_id === versionId) return opts.graph;
        return null;
      },
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadLastInboundBody: async () => null,
      loadEnrollmentEvents: async () => [...events],
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
      updateEnrollment: async (_id, _orgId, patch) => {
        currentEnrollment = {
          ...currentEnrollment,
          ...patch,
          updated_at: new Date().toISOString(),
        };
      },
      loadFlowPointerName: async () => "Fluxo Teste",
      insertDeadInboxItem: async () => {},
      persistirRespostaFollowup: async () => {},
      signalPresence: async (input) => {
        signals.push({ presence: input.presence });
      },
      enqueueJob: async (job) => {
        enqueuedJobs.push(job);
      },
    };

    return {
      db,
      getEnrollment: () => currentEnrollment,
      getEvents: () => events,
      getEnqueuedJobs: () => enqueuedJobs,
      getSignals: () => signals,
    };
  }

  it("send_message -> typing 5s -> send_message: creates wait_wake and NOT future send_message", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "txt1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Msg 1" } },
        { id: "typ", type: "typing", label: "Typing 5s", position: { x: 0, y: 0 }, config: { duration_seconds: 5 } },
        { id: "txt2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "Msg 2" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "txt1", target: "typ", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "typ", target: "txt2", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "txt2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    let currentTime = T0;
    const testClock = () => currentTime;

    const initialEnrollment = enrollment({
      current_node_id: "txt1",
      steps_taken: 1,
      started_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    });

    const harness = createPathBHarness({ enrollment: initialEnrollment, graph: GRAPH });

    // Step 1: txt1 completes sending ("sent") via turn-bridge
    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "txt1",
      { kind: "sent" },
      testClock,
    );

    // 1a: Enrollment must be parked on 'typ'
    expect(harness.getEnrollment().current_node_id).toBe("typ");
    expect(harness.getEnrollment().status).toBe("active");

    // 1b: Intermediate job must be wait_wake
    const wakeJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "wait_wake");
    expect(wakeJobs.length).toBe(1);
    expect(wakeJobs[0]!.payload.node_id).toBe("typ");
    expect(wakeJobs[0]!.payload.followup_enrollment_id).toBe(initialEnrollment.id);
    expect(wakeJobs[0]!.run_after!.getTime() - T0.getTime()).toBe(5000);

    // 1c: CRITICAL: MUST NOT create any send_message job yet!
    const sendJobsStep1 = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "send_message");
    expect(sendJobsStep1.length).toBe(0);

    // 1d: Events check
    expect(harness.getEvents().some((e) => e.node_id === "typ" && e.event_type === "wait_started")).toBe(true);

    // Step 2: 5s later, wake job fires
    currentTime = new Date(T0.getTime() + 5000);
    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "typ",
      { kind: "wake" },
      testClock,
    );

    // 2a: Advanced to txt2
    expect(harness.getEnrollment().current_node_id).toBe("txt2");

    // 2b: Next message is now enqueued with immediate run_after
    const sendJobsStep2 = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "send_message");
    expect(sendJobsStep2.length).toBe(1);
    expect(sendJobsStep2[0]!.payload.node_id).toBe("txt2");
    expect(sendJobsStep2[0]!.payload.fixed_body).toBe("Msg 2");
    expect(sendJobsStep2[0]!.run_after).toBeUndefined();
  });

  it("send_message -> delay 60s -> send_message: creates wait_wake and NOT future send_message", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "txt1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Msg 1" } },
        { id: "del", type: "delay", label: "Delay 60s", position: { x: 0, y: 0 }, config: { duration_value: 60, unit: "minutes" } },
        { id: "txt2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "Msg 2" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "txt1", target: "del", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "del", target: "txt2", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "txt2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    let currentTime = T0;
    const testClock = () => currentTime;

    const initialEnrollment = enrollment({
      current_node_id: "txt1",
      steps_taken: 1,
      started_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    });

    const harness = createPathBHarness({ enrollment: initialEnrollment, graph: GRAPH });

    // Step 1: txt1 completes sending ("sent")
    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "txt1",
      { kind: "sent" },
      testClock,
    );

    // 1a: Enrollment parked on 'del'
    expect(harness.getEnrollment().current_node_id).toBe("del");
    expect(harness.getEnrollment().status).toBe("active");

    // 1b: Intermediate job must be wait_wake with run_after = 60 * 60 * 1000 = 3600000ms
    const wakeJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "wait_wake");
    expect(wakeJobs.length).toBe(1);
    expect(wakeJobs[0]!.payload.node_id).toBe("del");
    expect(wakeJobs[0]!.run_after!.getTime() - T0.getTime()).toBe(3600000);

    // 1c: CRITICAL: NO send_message job created yet!
    const sendJobsStep1 = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "send_message");
    expect(sendJobsStep1.length).toBe(0);

    // Step 2: 60 minutes later, wake job fires
    currentTime = new Date(T0.getTime() + 3600000);
    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "del",
      { kind: "wake" },
      testClock,
    );

    // 2a: Advanced to txt2
    expect(harness.getEnrollment().current_node_id).toBe("txt2");

    // 2b: Next message enqueued immediately
    const sendJobsStep2 = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "send_message");
    expect(sendJobsStep2.length).toBe(1);
    expect(sendJobsStep2[0]!.payload.node_id).toBe("txt2");
    expect(sendJobsStep2[0]!.run_after).toBeUndefined();
  });

  it("delay with immune_to_reply: true marks status as 'dormente' and wakes to active", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "txt1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Msg 1" } },
        { id: "del", type: "delay", label: "Delay Imune", position: { x: 0, y: 0 }, config: { duration_value: 2, unit: "hours", immune_to_reply: true } },
        { id: "txt2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "Msg 2" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "txt1", target: "del", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "del", target: "txt2", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "txt2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    let currentTime = T0;
    const testClock = () => currentTime;

    const initialEnrollment = enrollment({
      current_node_id: "txt1",
      steps_taken: 1,
      started_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    });

    const harness = createPathBHarness({ enrollment: initialEnrollment, graph: GRAPH });

    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "txt1",
      { kind: "sent" },
      testClock,
    );

    expect(harness.getEnrollment().current_node_id).toBe("del");
    expect(harness.getEnrollment().status).toBe("dormente");

    const wakeJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "wait_wake");
    expect(wakeJobs.length).toBe(1);

    // Wake
    currentTime = new Date(T0.getTime() + 2 * 3600000);
    await completeTurnForEnrollment(
      harness.db,
      "org-1",
      initialEnrollment.id,
      "del",
      { kind: "wake" },
      testClock,
    );

    expect(harness.getEnrollment().current_node_id).toBe("txt2");
    expect(harness.getEnrollment().status).toBe("active");
  });
});

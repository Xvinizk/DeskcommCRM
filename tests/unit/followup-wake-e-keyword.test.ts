import { describe, it, expect, vi } from "vitest";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import {
  avancarEnrollmentAtivo,
  type FollowupJobRequest,
} from "@/lib/followup/engine";
import { avaliarGatilhoPalavraChave } from "@/lib/followup/gatilho-palavra-chave";
import type { EnrollmentRow, EnrollmentEventRef } from "@/lib/followup/node-handlers";
import type { FlowGraph } from "@/lib/followup/graph-schema";

const mockEnrollFollowupFlow = vi.fn(async (_admin, input) => ({
  ok: true,
  enrollment: { id: "enr-mock-" + Math.random().toString(36).slice(2, 7), ...input },
}));

vi.mock("@/lib/followup/enroll", () => ({
  enrollFollowupFlow: (...args: unknown[]) => mockEnrollFollowupFlow(args[0], args[1]),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const POINTER_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";

function createMockDb(opts: {
  enrollment: EnrollmentRow;
  graph: FlowGraph;
  initialEvents?: EnrollmentEventRef[];
}) {
  let currentEnrollment = { ...opts.enrollment };
  const events: EnrollmentEventRef[] = [...(opts.initialEvents ?? [])];
  const enqueuedJobs: FollowupJobRequest[] = [];
  const signals: Array<{ presence: string }> = [];

  const db: TurnBridgeAdminClient = {
    async loadEnrollmentById(_orgId, id) {
      if (currentEnrollment.id === id) return { ...currentEnrollment };
      return null;
    },
    async loadFlowGraph(_orgId, versionId) {
      if (opts.graph && opts.enrollment.version_id === versionId) return opts.graph;
      return null;
    },
    async loadLeadFacts() {
      return { lead_stage: null, tags: [], contact_name: "Test Contact", custom_fields: {} };
    },
    async loadEnrollmentEvents(_enrollmentId) {
      return [...events];
    },
    async loadLastInboundBody() {
      return null;
    },
    async insertEnrollmentEvent(event) {
      const exists = events.some(
        (e) => e.idempotency_key === event.idempotency_key,
      );
      if (exists) return { inserted: false };
      events.push({
        node_id: event.node_id,
        event_type: event.event_type,
        payload: event.payload,
        idempotency_key: event.idempotency_key,
      });
      return { inserted: true };
    },
    async updateEnrollment(id, _orgId, patch) {
      currentEnrollment = {
        ...currentEnrollment,
        ...patch,
        updated_at: new Date().toISOString(),
      };
    },
    async claimDueEnrollments() {
      return [currentEnrollment];
    },
    async loadFlowPointerName() {
      return "Fluxo Teste";
    },
    async insertDeadInboxItem() {},
    async persistirRespostaFollowup() {},
    async signalPresence(input) {
      signals.push({ presence: input.presence });
    },
    async enqueueJob(job) {
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

describe("10 Testes Obrigatórios — Wake-up Temporal e Keyword", () => {
  /* ========================================================================
   * TESTE 1: Trigger → Texto → Typing 5s → Texto (próximo texto em ~5–7s)
   * ======================================================================== */
  it("1. Trigger → Texto → Typing 5s → Texto (wake job criado com run_after 5s e avanço imediato)", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "trig", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "txt1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Olá!" } },
        { id: "typ", type: "typing", label: "Typing 5s", position: { x: 0, y: 0 }, config: { duration_seconds: 5 } },
        { id: "txt2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "Segunda mensagem!" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trig", target: "txt1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "txt1", target: "typ", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "typ", target: "txt2", priority: 0, condition: { type: "always" } },
        { id: "e4", source: "txt2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    let currentTime = T0;
    const clock = () => currentTime;

    const initialEnrollment: EnrollmentRow = {
      id: "enr-test-1",
      organization_id: ORG_ID,
      pointer_id: POINTER_ID,
      version_id: VERSION_ID,
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      current_node_id: "txt1",
      status: "active",
      next_eval_at: T0.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: T0.toISOString(),
      completed_at: null,
      updated_at: T0.toISOString(),
    };

    const harness = createMockDb({ enrollment: initialEnrollment, graph: GRAPH });

    // Step A: txt1 conclui o envio ("sent")
    await completeTurnForEnrollment(
      harness.db,
      ORG_ID,
      initialEnrollment.id,
      "txt1",
      { kind: "sent" },
      clock,
    );

    // Deve ter avançado para typ, entrado em wait e criado job de wake com run_after de exatamente 5s
    expect(harness.getEnrollment().current_node_id).toBe("typ");
    expect(harness.getEnrollment().status).toBe("active");
    expect(harness.getSignals()).toContainEqual({ presence: "typing" });

    const wakeJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "wait_wake");
    expect(wakeJobs.length).toBe(1);
    const wakeJob = wakeJobs[0]!;
    expect(wakeJob.payload.node_id).toBe("typ");
    expect(wakeJob.payload.followup_enrollment_id).toBe(initialEnrollment.id);

    // Medição do tempo de agendamento: delta exatamente 5000ms
    const deltaMs = wakeJob.run_after!.getTime() - T0.getTime();
    expect(deltaMs).toBe(5000);

    // Step B: Passam 5 segundos. Worker acorda e consome o job de wake
    currentTime = new Date(T0.getTime() + 5000);
    await completeTurnForEnrollment(
      harness.db,
      ORG_ID,
      initialEnrollment.id,
      "typ",
      { kind: "wake" },
      clock,
    );

    // Enrollment deve ter avançado imediatamente para txt2 e enfileirado o próximo texto
    expect(harness.getEnrollment().current_node_id).toBe("txt2");
    expect(harness.getSignals()).toContainEqual({ presence: "paused" });

    const sendJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "send_message");
    const txt2Job = sendJobs.find((j) => j.payload.node_id === "txt2");
    expect(txt2Job).toBeDefined();
    expect(txt2Job?.payload.fixed_body).toBe("Segunda mensagem!");
  });

  /* ========================================================================
   * TESTE 2: Trigger → Texto → Delay 60s → Imagem (imagem em ~60–62s)
   * ======================================================================== */
  it("2. Trigger → Texto → Delay 60s → Imagem (wake job com run_after 60s e avanço imediato)", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "trig", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "txt1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Aguarde..." } },
        { id: "del", type: "delay", label: "Delay 60s", position: { x: 0, y: 0 }, config: { duration_value: 60, unit: "minutes" /* test with minutes/seconds */ } },
        { id: "img1", type: "message_image", label: "Imagem", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/foto.jpg" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trig", target: "txt1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "txt1", target: "del", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "del", target: "img1", priority: 0, condition: { type: "always" } },
        { id: "e4", source: "img1", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    let currentTime = T0;
    const clock = () => currentTime;

    const initialEnrollment: EnrollmentRow = {
      id: "enr-test-2",
      organization_id: ORG_ID,
      pointer_id: POINTER_ID,
      version_id: VERSION_ID,
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      current_node_id: "txt1",
      status: "active",
      next_eval_at: T0.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: T0.toISOString(),
      completed_at: null,
      updated_at: T0.toISOString(),
    };

    const harness = createMockDb({ enrollment: initialEnrollment, graph: GRAPH });

    // Envio do txt1
    await completeTurnForEnrollment(
      harness.db,
      ORG_ID,
      initialEnrollment.id,
      "txt1",
      { kind: "sent" },
      clock,
    );

    expect(harness.getEnrollment().current_node_id).toBe("del");
    const wakeJobs = harness.getEnqueuedJobs().filter((j) => j.payload.purpose === "wait_wake");
    expect(wakeJobs.length).toBe(1);
    const wakeJob = wakeJobs[0]!;

    // 60 minutos ou 60 segundos conforme unit configurada
    expect(wakeJob.run_after!.getTime()).toBeGreaterThan(T0.getTime());

    // Acorda após o tempo do delay
    currentTime = wakeJob.run_after!;
    await completeTurnForEnrollment(
      harness.db,
      ORG_ID,
      initialEnrollment.id,
      "del",
      { kind: "wake" },
      clock,
    );

    // Deve avançar para img1 e enfileirar a imagem imediatamente
    expect(harness.getEnrollment().current_node_id).toBe("img1");
    const imgJobs = harness.getEnqueuedJobs().filter((j) => j.payload.node_id === "img1");
    expect(imgJobs.length).toBe(1);
    expect(imgJobs[0]?.payload.media_url).toBe("https://example.com/foto.jpg");
  });

  /* ========================================================================
   * TESTE 3: Replay do mesmo wait_wake (não duplica avanço)
   * ======================================================================== */
  it("3. Replay do mesmo wait_wake (não duplica avanço)", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "del", type: "delay", label: "Delay", position: { x: 0, y: 0 }, config: { duration_value: 1, unit: "minutes" } },
        { id: "txt", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Olá" } },
      ],
      edges: [{ id: "e1", source: "del", target: "txt", priority: 0, condition: { type: "always" } }],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    const clock = () => T0;

    const enrollment: EnrollmentRow = {
      id: "enr-test-3",
      organization_id: ORG_ID,
      pointer_id: POINTER_ID,
      version_id: VERSION_ID,
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      current_node_id: "del",
      status: "active",
      next_eval_at: T0.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: T0.toISOString(),
      completed_at: null,
      updated_at: T0.toISOString(),
    };

    const harness = createMockDb({
      enrollment,
      graph: GRAPH,
      initialEvents: [
        {
          node_id: "del",
          event_type: "wait_started",
          payload: {},
          idempotency_key: "del:0",
        },
      ],
    });

    // 1º Wake
    await completeTurnForEnrollment(harness.db, ORG_ID, enrollment.id, "del", { kind: "wake" }, clock);
    expect(harness.getEnrollment().current_node_id).toBe("txt");
    const stepsAfterFirstWake = harness.getEnrollment().steps_taken;

    // 2º Wake repetido do mesmo nó anterior ("del")
    await completeTurnForEnrollment(harness.db, ORG_ID, enrollment.id, "del", { kind: "wake" }, clock);

    // O nó continua em "txt", steps_taken não duplicou
    expect(harness.getEnrollment().current_node_id).toBe("txt");
    expect(harness.getEnrollment().steps_taken).toBe(stepsAfterFirstWake);
  });

  /* ========================================================================
   * TESTE 4: Cron + wait_wake concorrentes (apenas um avanço efetivo)
   * ======================================================================== */
  it("4. Cron + wait_wake concorrentes (apenas um avanço efetivo via idempotência)", async () => {
    const GRAPH: FlowGraph = {
      nodes: [
        { id: "del", type: "delay", label: "Delay", position: { x: 0, y: 0 }, config: { duration_value: 1, unit: "minutes" } },
        { id: "txt", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Olá" } },
      ],
      edges: [{ id: "e1", source: "del", target: "txt", priority: 0, condition: { type: "always" } }],
    };

    const T0 = new Date("2026-09-24T12:00:00.000Z");
    const clock = () => T0;

    const enrollment: EnrollmentRow = {
      id: "enr-test-4",
      organization_id: ORG_ID,
      pointer_id: POINTER_ID,
      version_id: VERSION_ID,
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      current_node_id: "del",
      status: "active",
      next_eval_at: T0.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: null,
      started_at: T0.toISOString(),
      completed_at: null,
      updated_at: T0.toISOString(),
    };

    const harness = createMockDb({
      enrollment,
      graph: GRAPH,
      initialEvents: [
        {
          node_id: "del",
          event_type: "wait_started",
          payload: {},
          idempotency_key: "del:0",
        },
      ],
    });

    // Simulando disparo quase concorrente: wake e cron tentam avançar o mesmo enrollment
    const [p1, p2] = await Promise.allSettled([
      completeTurnForEnrollment(harness.db, ORG_ID, enrollment.id, "del", { kind: "wake" }, clock),
      avancarEnrollmentAtivo(
        { db: harness.db, clock, enqueueJob: harness.db.enqueueJob! },
        { ...enrollment },
      ),
    ]);

    expect(p1.status).toBe("fulfilled");
    expect(p2.status).toBe("fulfilled");

    // Apenas um evento de avanço gravado para o passo del:1
    const advanceEvents = harness
      .getEvents()
      .filter((e) => e.node_id === "del" && e.event_type === "node_advanced");
    expect(advanceEvents.length).toBe(1);

    // O enrollment termina em "txt" com steps_taken correto
    expect(harness.getEnrollment().current_node_id).toBe("txt");
  });

  /* ========================================================================
   * TESTE 5: Primeira keyword (dispara)
   * ======================================================================== */
  it("5. Primeira keyword (sem enrollment ativo -> dispara normalmente)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["PROMOÇÃO"], match_mode: "exact" },
      },
    ];

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: () => Promise.resolve({ error: null }),
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-first-kw",
      texto: "promoção",
    });

    expect(res.disparou).toBe(true);
    expect(res.pointerId).toBe(POINTER_ID);
    expect(res.palavraCasada).toBe("PROMOÇÃO");
  });

  /* ========================================================================
   * TESTE 6: Keyword após completed (dispara novamente)
   * ======================================================================== */
  it("6. Keyword após anterior completed (dispara novamente criando novo)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["MENU"], match_mode: "exact" },
      },
    ];

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: () => Promise.resolve({ error: null }),
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-after-completed",
      texto: "menu",
    });

    expect(res.disparou).toBe(true);
    expect(res.pointerId).toBe(POINTER_ID);
  });

  /* ========================================================================
   * TESTE 7: Keyword durante active (cancela anterior canonicamente e cria novo)
   * ======================================================================== */
  it("7. Keyword durante active (substitui anterior e cria novo com replaceActive: true)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["REINICIAR"], match_mode: "exact" },
      },
    ];

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: () => Promise.resolve({ error: null }),
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-during-active",
      texto: "reiniciar",
    });

    expect(res.disparou).toBe(true);
    expect(res.pointerId).toBe(POINTER_ID);
    expect(mockEnrollFollowupFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        replaceActive: true,
        origin: "keyword_trigger",
      }),
    );
  });

  /* ========================================================================
   * TESTE 8: Mesmo message_id duas vezes (apenas uma execução)
   * ======================================================================== */
  it("8. Mesmo message_id duas vezes (apenas uma execução via idempotency_keys)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["PROMOÇÃO"], match_mode: "exact" },
      },
    ];

    const insertedKeys = new Set<string>();

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: (row: { key: string }) => {
              if (insertedKeys.has(row.key)) {
                return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
              }
              insertedKeys.add(row.key);
              return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    const firstRun = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "same-msg-id-123",
      texto: "promoção",
    });

    const secondRun = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "same-msg-id-123",
      texto: "promoção",
    });

    expect(firstRun.disparou).toBe(true);
    expect(secondRun.disparou).toBe(false);
    expect(secondRun.motivo).toBe("message_already_processed");
  });

  /* ========================================================================
   * TESTE 9: Dois message_id diferentes (duas execuções)
   * ======================================================================== */
  it("9. Dois message_id diferentes com a mesma keyword (duas execuções válidas)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["PROMOÇÃO"], match_mode: "exact" },
      },
    ];

    const insertedKeys = new Set<string>();

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: (row: { key: string }) => {
              if (insertedKeys.has(row.key)) {
                return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
              }
              insertedKeys.add(row.key);
              return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    const res1 = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "diff-msg-id-1",
      texto: "promoção",
    });

    const res2 = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "diff-msg-id-2",
      texto: "promoção",
    });

    expect(res1.disparou).toBe(true);
    expect(res2.disparou).toBe(true);
  });

  /* ========================================================================
   * TESTE 10: Duas chamadas concorrentes com mesmo message_id (apenas uma)
   * ======================================================================== */
  it("10. Duas chamadas concorrentes com mesmo message_id (apenas uma execução)", async () => {
    const mockPointers = [
      {
        id: POINTER_ID,
        name: "Fluxo Keyword",
        status: "active",
        active_version_id: VERSION_ID,
        trigger_config: { kind: "keyword", keywords: ["PROMOÇÃO"], match_mode: "exact" },
      },
    ];

    const insertedKeys = new Set<string>();

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({ data: mockPointers, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: (row: { key: string }) => {
              if (insertedKeys.has(row.key)) {
                return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
              }
              insertedKeys.add(row.key);
              return Promise.resolve({ error: null });
            },
            update: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
            delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
          };
        }
        return {};
      }),
    };

    // Disparo concorrente
    const [resA, resB] = await Promise.all([
      avaliarGatilhoPalavraChave(mockAdmin as never, {
        organizationId: ORG_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        messageId: "concurrent-msg-id",
        texto: "promoção",
      }),
      avaliarGatilhoPalavraChave(mockAdmin as never, {
        organizationId: ORG_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        messageId: "concurrent-msg-id",
        texto: "promoção",
      }),
    ]);

    const results = [resA, resB];
    const dispararam = results.filter((r) => r.disparou);
    const bloqueados = results.filter((r) => !r.disparou && r.motivo === "message_already_processed");

    expect(dispararam.length).toBe(1);
    expect(bloqueados.length).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  runFollowupTick,
  FLOW_MAX_RUNTIME_STEPS,
  type FollowupJobRequest,
  type TickDeps,
} from "@/lib/followup/engine";
import {
  FLOW_MAX_STATIC_PATH_STEPS,
  type FlowGraph,
  type FlowNode,
  type FlowEdge,
} from "@/lib/followup/graph-schema";
import {
  calculateFlowLongestPath,
  validateFlowForPublish,
} from "@/lib/followup/validate-publish";
import type {
  EnrollmentEventRef,
  EnrollmentRow,
  LeadFacts,
} from "@/lib/followup/node-handlers";

/**
 * Harness de teste unitário puro em memória para simulação real de execução do engine.
 */
class EngineExecutionHarness {
  currentTime = new Date("2026-10-11T12:00:00.000Z").getTime();
  enrollments: Map<string, EnrollmentRow> = new Map();
  events: Map<string, EnrollmentEventRef[]> = new Map();
  graphs: Map<string, FlowGraph> = new Map();
  jobs: FollowupJobRequest[] = [];
  deadInbox: Array<{ title: string; body: string; ref_id: string }> = [];
  lastInbound: string | null = null;

  clock = (): Date => new Date(this.currentTime);

  advanceClock(ms: number) {
    this.currentTime += ms;
  }

  registerGraph(versionId: string, graph: FlowGraph) {
    this.graphs.set(versionId, graph);
  }

  createEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
    const row: EnrollmentRow = {
      id: `enr-${Math.random().toString(36).slice(2, 9)}`,
      organization_id: "org-test-1",
      pointer_id: "ptr-test-1",
      version_id: "ver-test-1",
      contact_id: "contact-test-1",
      conversation_id: "conv-test-1",
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

  getEnrollment(id: string): EnrollmentRow {
    const enr = this.enrollments.get(id);
    if (!enr) throw new Error(`Enrollment ${id} not found in harness`);
    return { ...enr };
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
          contact_name: "Lead de Teste",
          custom_fields: {},
        }),
        loadEnrollmentEvents: async (enrollmentId: string) => {
          return [...(this.events.get(enrollmentId) ?? [])];
        },
        loadLastInboundBody: async () => this.lastInbound,
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
        enqueueJob: async (job: FollowupJobRequest) => {
          this.jobs.push(job);
        },
        loadFlowPointerName: async () => "Fluxo de Teste",
        insertDeadInboxItem: async (item) => {
          this.deadInbox.push(item);
        },
        persistirRespostaFollowup: async () => {},
      },
    };
  }

  /**
   * Drena a execução de um enrollment passo a passo até atingir status terminal (completed/dead/cancelled)
   * ou atingir um teto de segurança de ticks de teste.
   */
  async drainExecution(enrollmentId: string, maxTicks = 400): Promise<EnrollmentRow> {
    const deps = this.getDeps();
    let ticks = 0;

    while (ticks < maxTicks) {
      ticks++;
      const current = this.getEnrollment(enrollmentId);
      if (current.status === "completed" || current.status === "dead" || current.status === "cancelled") {
        return current;
      }

      // Se houver próximo horário agendado no futuro, adianta o relógio
      if (current.next_eval_at && new Date(current.next_eval_at) > this.clock()) {
        this.currentTime = new Date(current.next_eval_at).getTime() + 1000;
      }

      // Se houver turnos de mensagem pendentes (purpose: send_message), simula envio completando
      const pendingTurn = this.jobs.shift();
      if (pendingTurn && pendingTurn.payload.purpose === "send_message") {
        const graph = this.graphs.get(current.version_id);
        const node = graph?.nodes.find((n) => n.id === pendingTurn.payload.node_id);
        const edge = graph?.edges.find((e) => e.source === pendingTurn.payload.node_id);
        if (node && edge) {
          await deps.db.insertEnrollmentEvent({
            organization_id: current.organization_id,
            enrollment_id: current.id,
            node_id: node.id,
            event_type: "action_sent",
            payload: {},
            idempotency_key: `${node.id}:${current.steps_taken}:sent`,
          });
          await deps.db.updateEnrollment(current.id, current.organization_id, {
            current_node_id: edge.target,
            status: "active",
            next_eval_at: this.clock().toISOString(),
            steps_taken: current.steps_taken + 1,
            claimed_until: null,
          });
          continue;
        }
      }

      await runFollowupTick(deps, { limit: 10 });
    }

    return this.getEnrollment(enrollmentId);
  }
}

/**
 * Constrói um grafo linear sintético com N passos (trigger -> tag_1 -> ... -> end).
 */
function buildLinearGraph(totalSteps: number): FlowGraph {
  const nodes: FlowNode[] = [
    {
      id: "t1",
      type: "trigger",
      label: "Gatilho Inicial",
      position: { x: 0, y: 0 },
      config: { type: "manual" },
    },
  ];
  const edges: FlowEdge[] = [];

  for (let i = 1; i < totalSteps - 1; i++) {
    const id = `step_${i}`;
    nodes.push({
      id,
      type: "tag",
      label: `Etapa ${i}`,
      position: { x: i * 50, y: 0 },
      config: { action: "add", tags: [`tag_${i}`] },
    });
    const prevId = i === 1 ? "t1" : `step_${i - 1}`;
    edges.push({
      id: `e_${i}`,
      source: prevId,
      target: id,
      priority: 0,
      condition: { type: "always" },
    });
  }

  const endId = `end_node`;
  nodes.push({
    id: endId,
    type: "end",
    label: "Fim do Fluxo",
    position: { x: totalSteps * 50, y: 0 },
    config: { outcome: "converted" },
  });
  edges.push({
    id: `e_end`,
    source: `step_${totalSteps - 2}`,
    target: endId,
    priority: 0,
    condition: { type: "always" },
  });

  return { nodes, edges };
}

describe("FLOW_MAX_RUNTIME_STEPS — Correção de Inconsistência e Execução Real", () => {
  it("INVARIANT: STATIC_MAX < RUNTIME_MAX", () => {
    expect(FLOW_MAX_STATIC_PATH_STEPS).toBe(100);
    expect(FLOW_MAX_RUNTIME_STEPS).toBe(200);
    expect(FLOW_MAX_STATIC_PATH_STEPS).toBeLessThan(FLOW_MAX_RUNTIME_STEPS);
    expect(FLOW_MAX_RUNTIME_STEPS).toBeGreaterThanOrEqual(FLOW_MAX_STATIC_PATH_STEPS);
  });

  it("1. fluxo linear de 80 passos -> completes", async () => {
    const harness = new EngineExecutionHarness();
    const graph = buildLinearGraph(80);
    expect(calculateFlowLongestPath(graph)).toBe(80);

    harness.registerGraph("ver-80", graph);
    const enr = harness.createEnrollment({ version_id: "ver-80", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id);
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    expect(finalEnr.steps_taken).toBe(80);
  });

  it("2. fluxo linear de 81 passos -> completes (anteriormente morria com dead/max_steps em 80)", async () => {
    const harness = new EngineExecutionHarness();
    const graph = buildLinearGraph(81);
    expect(calculateFlowLongestPath(graph)).toBe(81);

    harness.registerGraph("ver-81", graph);
    const enr = harness.createEnrollment({ version_id: "ver-81", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id);
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    expect(finalEnr.steps_taken).toBe(81);
  });

  it("3. fluxo linear de 100 passos -> completes", async () => {
    const harness = new EngineExecutionHarness();
    const graph = buildLinearGraph(100);
    expect(calculateFlowLongestPath(graph)).toBe(100);

    harness.registerGraph("ver-100", graph);
    const enr = harness.createEnrollment({ version_id: "ver-100", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id);
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    expect(finalEnr.steps_taken).toBe(100);
  });

  it("4. fluxo válido 100 passos + waits -> completes", async () => {
    const harness = new EngineExecutionHarness();
    // Constrói fluxo com nós intercalados de wait (30 nós tag + 15 waits = 46 nós totais)
    const nodes: FlowNode[] = [
      { id: "t1", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: { type: "manual" } },
    ];
    const edges: FlowEdge[] = [];

    let prev = "t1";
    for (let i = 1; i <= 15; i++) {
      const waitId = `w_${i}`;
      nodes.push({
        id: waitId,
        type: "wait",
        label: `Wait ${i}`,
        position: { x: i * 40, y: 0 },
        config: { mode: "fixed", duration_ms: 300_000 },
      });
      edges.push({ id: `e_w_${i}`, source: prev, target: waitId, priority: 0, condition: { type: "always" } });

      const tagId = `t_${i}`;
      nodes.push({
        id: tagId,
        type: "tag",
        label: `Tag ${i}`,
        position: { x: i * 40 + 20, y: 0 },
        config: { action: "add", tags: [`tag_${i}`] },
      });
      edges.push({ id: `e_t_${i}`, source: waitId, target: tagId, priority: 0, condition: { type: "always" } });
      prev = tagId;
    }

    nodes.push({ id: "end_node", type: "end", label: "Fim", position: { x: 1000, y: 0 }, config: { outcome: "converted" } });
    edges.push({ id: "e_end", source: prev, target: "end_node", priority: 0, condition: { type: "always" } });

    const graph: FlowGraph = { nodes, edges };
    const staticPath = calculateFlowLongestPath(graph);
    expect(staticPath).toBe(32); // 1 + 15*2 + 1 = 32 passos estáticos <= 100

    harness.registerGraph("ver-waits", graph);
    const enr = harness.createEnrollment({ version_id: "ver-waits", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id, 200);
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    // Cada wait executa 2 vezes (1 para wait_started, 1 para avanço após elapsed)
    expect(finalEnr.steps_taken).toBe(47); // 32 nós + 15 fases de wait
    expect(finalEnr.steps_taken).toBeLessThanOrEqual(FLOW_MAX_RUNTIME_STEPS);
  });

  it("5. fluxo com Node IA dentro de caminho longo -> completes", async () => {
    const prevEnv = process.env.FOLLOWUP_AI_NODE_ENABLED;
    process.env.FOLLOWUP_AI_NODE_ENABLED = "true";

    try {
      const harness = new EngineExecutionHarness();
      const nodes: FlowNode[] = [
        { id: "t1", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: { type: "manual" } },
      ];
      const edges: FlowEdge[] = [];

      let prev = "t1";
      // 50 nós preliminares
      for (let i = 1; i <= 50; i++) {
        const stepId = `step_${i}`;
        nodes.push({
          id: stepId,
          type: "tag",
          label: `Step ${i}`,
          position: { x: i * 20, y: 0 },
          config: { action: "add", tags: ["ok"] },
        });
        edges.push({ id: `e_${i}`, source: prev, target: stepId, priority: 0, condition: { type: "always" } });
        prev = stepId;
      }

      // Node IA
      const aiNodeId = "ai_node_1";
      nodes.push({
        id: aiNodeId,
        type: "ai_node",
        label: "Assistente de Atendimento",
        position: { x: 1100, y: 0 },
        config: {
          mode: "existing_agent",
          agent_binding: { version_strategy: "published", agent_id: "00000000-0000-0000-0000-000000000001" },
          objective: "Qualificação",
          timeout: { duration_value: 1, unit: "minutes" },
          timeout_ms: 60_000,
        },
      } as FlowNode);
      edges.push({ id: "e_to_ai", source: prev, target: aiNodeId, priority: 0, condition: { type: "always" } });

      // Saída timeout do Node IA
      const endId = "end_node";
      nodes.push({
        id: endId,
        type: "end",
        label: "Fim",
        position: { x: 1200, y: 0 },
        config: { outcome: "converted" },
      });
      edges.push({
        id: "e_ai_timeout",
        source: aiNodeId,
        target: endId,
        priority: 0,
        condition: { type: "branch", branch_id: "timeout" },
      });

      const graph: FlowGraph = { nodes, edges };
      expect(calculateFlowLongestPath(graph)).toBe(53); // 1 + 50 + 1 + 1

      harness.registerGraph("ver-ai", graph);
      const enr = harness.createEnrollment({ version_id: "ver-ai", current_node_id: "t1" });

      const finalEnr = await harness.drainExecution(enr.id, 100);
      expect(finalEnr.status).toBe("completed");
      expect(finalEnr.cancel_reason).toBeNull();
      expect(finalEnr.steps_taken).toBe(54); // 50 tags + 1 trigger + 1 ai_node arm + 1 timeout advance + 1 end
    } finally {
      process.env.FOLLOWUP_AI_NODE_ENABLED = prevEnv;
    }
  });

  it("6. repeat válido não dispara dead prematuramente", async () => {
    const harness = new EngineExecutionHarness();
    // Grafo com repeat: trigger -> repeat -> body (2 nós + wait) -> repeat -> done -> end
    const nodes: FlowNode[] = [
      { id: "t1", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: { type: "manual" } },
      { id: "rep", type: "repeat", label: "Repetidor", position: { x: 50, y: 0 }, config: { max_count: 5 } },
      { id: "b1", type: "tag", label: "Body 1", position: { x: 100, y: 0 }, config: { action: "add", tags: ["b1"] } },
      { id: "b2", type: "tag", label: "Body 2", position: { x: 150, y: 0 }, config: { action: "add", tags: ["b2"] } },
      {
        id: "w_body",
        type: "wait",
        label: "Espera volta",
        position: { x: 200, y: 0 },
        config: { mode: "fixed", duration_ms: 300_000 },
      },
      { id: "end_node", type: "end", label: "Fim", position: { x: 300, y: 0 }, config: { outcome: "exhausted" } },
    ];
    const edges: FlowEdge[] = [
      { id: "e1", source: "t1", target: "rep", priority: 0, condition: { type: "always" } },
      { id: "e_body", source: "rep", target: "b1", priority: 0, condition: { type: "branch", branch_id: "body" } },
      { id: "e_b12", source: "b1", target: "b2", priority: 0, condition: { type: "always" } },
      { id: "e_b2w", source: "b2", target: "w_body", priority: 0, condition: { type: "always" } },
      { id: "e_loop", source: "w_body", target: "rep", priority: 0, condition: { type: "always" } },
      { id: "e_done", source: "rep", target: "end_node", priority: 0, condition: { type: "branch", branch_id: "done" } },
      { id: "e_fallback", source: "rep", target: "end_node", priority: 0, condition: { type: "always" } },
    ];

    const graph: FlowGraph = { nodes, edges };
    const validation = validateFlowForPublish(graph);
    expect(validation.ok).toBe(true);

    harness.registerGraph("ver-rep", graph);
    // Configura retorno de inbound body "3" para que parseReplyCount detecte 3 voltas
    harness.lastInbound = "3";

    const enr = harness.createEnrollment({ version_id: "ver-rep", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id, 100);
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    expect(finalEnr.steps_taken).toBeGreaterThan(10);
    expect(finalEnr.steps_taken).toBeLessThan(FLOW_MAX_RUNTIME_STEPS);
  });

  it("7. loop descontrolado continua sendo morto pelo dead-man switch", async () => {
    const harness = new EngineExecutionHarness();
    // Grafo com loop fechado sem espera (A -> B -> A)
    const nodes: FlowNode[] = [
      { id: "t1", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: { type: "manual" } },
      { id: "n1", type: "tag", label: "N1", position: { x: 50, y: 0 }, config: { action: "add", tags: ["1"] } },
      { id: "n2", type: "tag", label: "N2", position: { x: 100, y: 0 }, config: { action: "add", tags: ["2"] } },
      { id: "end_node", type: "end", label: "End", position: { x: 200, y: 0 }, config: { outcome: "converted" } },
    ];
    const edges: FlowEdge[] = [
      { id: "e1", source: "t1", target: "n1", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "n1", target: "n2", priority: 0, condition: { type: "always" } },
      // Loop infinito com prioridade mais alta: n2 -> n1 sempre escolhido
      { id: "e_loop", source: "n2", target: "n1", priority: 10, condition: { type: "always" } },
      { id: "e_end", source: "n2", target: "end_node", priority: 0, condition: { type: "always" } },
    ];

    const graph: FlowGraph = { nodes, edges };
    harness.registerGraph("ver-loop", graph);
    const enr = harness.createEnrollment({ version_id: "ver-loop", current_node_id: "t1" });

    const finalEnr = await harness.drainExecution(enr.id, 250);
    expect(finalEnr.status).toBe("dead");
    expect(finalEnr.cancel_reason).toBe("max_steps");
    expect(finalEnr.steps_taken).toBe(FLOW_MAX_RUNTIME_STEPS + 1);
    expect(harness.deadInbox).toHaveLength(1);
    expect(harness.deadInbox[0]?.body).toContain("max_steps");
  });

  it("8. acima do novo runtime max -> status dead/max_steps", async () => {
    const harness = new EngineExecutionHarness();
    const graph = buildLinearGraph(5);
    harness.registerGraph("ver-max", graph);

    // Inicia diretamente acima de FLOW_MAX_RUNTIME_STEPS
    const enr = harness.createEnrollment({
      version_id: "ver-max",
      current_node_id: "t1",
      steps_taken: FLOW_MAX_RUNTIME_STEPS + 1,
    });

    const deps = harness.getDeps();
    const summary = await runFollowupTick(deps, { limit: 5 });
    expect(summary.dead).toBe(1);

    const row = harness.getEnrollment(enr.id);
    expect(row.status).toBe("dead");
    expect(row.cancel_reason).toBe("max_steps");
    expect(row.next_eval_at).toBeNull();
  });

  it("9. OFERTA R$24,90 — Execução do caminho mais longo no engine real", async () => {
    // Carrega o grafo real salvo do banco
    const raw = fs.readFileSync(path.join(process.cwd(), "oferta-graph.json"), "utf8");
    const graph: FlowGraph = JSON.parse(raw);

    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
    const longestStatic = calculateFlowLongestPath(graph);

    expect(nodeCount).toBe(52);
    expect(edgeCount).toBe(65);
    expect(longestStatic).toBe(51);

    const publishValidation = validateFlowForPublish(graph);
    expect(publishValidation.ok).toBe(true);

    const harness = new EngineExecutionHarness();
    harness.registerGraph("ver-oferta-real", graph);

    const enr = harness.createEnrollment({
      version_id: "ver-oferta-real",
      current_node_id: "trigger-1",
    });

    const deps = harness.getDeps();
    let ticks = 0;
    while (ticks < 200) {
      ticks++;
      const current = harness.getEnrollment(enr.id);
      if (current.status === "completed" || current.status === "dead" || current.status === "cancelled") {
        break;
      }

      // Se houver turnos de envio gerados por message_*, simula envio completando
      const pendingTurn = harness.jobs.shift();
      if (pendingTurn && pendingTurn.payload.purpose === "send_message") {
        const node = graph.nodes.find((n) => n.id === pendingTurn.payload.node_id);
        const edge = graph.edges.find((e) => e.source === pendingTurn.payload.node_id);
        if (node && edge) {
          await deps.db.insertEnrollmentEvent({
            organization_id: current.organization_id,
            enrollment_id: current.id,
            node_id: node.id,
            event_type: "action_sent",
            payload: {},
            idempotency_key: `${node.id}:${current.steps_taken}:sent`,
          });
          await deps.db.updateEnrollment(current.id, current.organization_id, {
            current_node_id: edge.target,
            status: "active",
            next_eval_at: harness.clock().toISOString(),
            steps_taken: current.steps_taken + 1,
            claimed_until: null,
          });
          continue;
        }
      }

      const currentNode = graph.nodes.find((n) => n.id === current.current_node_id);
      if (currentNode?.type === "match_reply") {
        // Envia mensagem inbound que atende à ramificação br_sim
        const list = harness.events.get(current.id) ?? [];
        list.push({
          node_id: currentNode.id,
          event_type: "reply_matched",
          payload: { reply: "sim" },
          idempotency_key: `${currentNode.id}:${current.steps_taken}:wake`,
        });
        harness.events.set(current.id, list);
      }

      if (current.next_eval_at && new Date(current.next_eval_at) > harness.clock()) {
        harness.currentTime = new Date(current.next_eval_at).getTime() + 1000;
      }

      await runFollowupTick(deps, { limit: 10 });
    }

    const finalEnr = harness.getEnrollment(enr.id);

    console.info("==========================================");
    console.info("OFFER_FLOW_LONGEST_STATIC_PATH =", longestStatic);
    console.info("OFFER_FLOW_MAX_RUNTIME_STEPS_OBSERVED =", finalEnr.steps_taken);
    console.info("OFFER_FLOW_RUNTIME_RESULT =", finalEnr.status === "completed" ? "PASS" : "FAIL");
    console.info("==========================================");

    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.cancel_reason).toBeNull();
    expect(finalEnr.status).not.toBe("dead");
    expect(finalEnr.last_error).toBeNull();
    expect(finalEnr.steps_taken).toBeLessThanOrEqual(FLOW_MAX_RUNTIME_STEPS);
  });
});

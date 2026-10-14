import { describe, it, expect } from "vitest";

import {
  avancarEnrollmentAtivo,
  runFollowupTick,
  type EnrollmentPatch,
  type FollowupJobRequest,
  type TickDeps,
} from "@/lib/followup/engine";
import {
  completeTurnForEnrollment,
  type TurnBridgeAdminClient,
} from "@/lib/followup/turn-bridge";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow, LeadFacts } from "@/lib/followup/node-handlers";

/**
 * Testes Unitários de Latência Event-Driven do Follow-up (Cenários A a H)
 *
 * Valida a eliminação da latência indevida entre nodes sem Delay/espera,
 * garantindo transições event-driven imediatas, respeito estrito aos nós temporais,
 * e tolerância a falhas via dead-man fallback.
 */

interface QueuedJob {
  id: string;
  organization_id: string;
  contact_id: string;
  payload: Record<string, unknown>;
  run_after?: Date;
}

class InMemoryHarness {
  currentTime: number;
  enrollments: Map<string, EnrollmentRow> = new Map();
  events: Map<string, EnrollmentEventRef[]> = new Map();
  graphs: Map<string, FlowGraph> = new Map();
  queue: QueuedJob[] = [];
  leadTags: string[] = [];
  leadStage: string | null = null;
  deadItems: Array<{ title: string; body: string; ref_id: string }> = [];
  revisions: Map<string, number> = new Map();
  jobSeq = 0;

  constructor(initialTimeStr = "2026-09-24T12:00:00.000Z") {
    this.currentTime = new Date(initialTimeStr).getTime();
  }

  clock = (): Date => new Date(this.currentTime);

  advanceTime(ms: number) {
    this.currentTime += ms;
  }

  createEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
    const row: EnrollmentRow = {
      id: "enr-test-1",
      organization_id: "org-test",
      pointer_id: "ptr-test",
      version_id: "ver-test",
      contact_id: "contact-test",
      conversation_id: "conv-test",
      service_boundary: null,
      revision: 1,
      appointment_id: null,
      appointment_revision: null,
      current_node_id: "trg",
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
    this.revisions.set(row.id, row.revision ?? 1);
    this.events.set(row.id, []);
    return row;
  }

  getAdminClient(): TurnBridgeAdminClient {
    return {
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
      loadLeadFacts: async (_orgId: string, _contactId: string): Promise<LeadFacts> => {
        return {
          lead_stage: this.leadStage,
          tags: [...this.leadTags],
          steps_taken: 0,
          last_outcome: null,
          contact_name: "Lead Teste",
          custom_fields: {},
        };
      },
      loadEnrollmentEvents: async (enrollmentId: string) => {
        return [...(this.events.get(enrollmentId) ?? [])];
      },
      loadLastInboundBody: async () => {
        return null;
      },
      insertEnrollmentEvent: async (event: {
        organization_id: string;
        enrollment_id: string;
        node_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        idempotency_key: string;
      }) => {
        const list = this.events.get(event.enrollment_id) ?? [];
        if (list.some((e) => e.idempotency_key === event.idempotency_key)) {
          return { inserted: false };
        }
        list.push({
          node_id: event.node_id,
          event_type: event.event_type,
          payload: event.payload,
          idempotency_key: event.idempotency_key,
        });
        this.events.set(event.enrollment_id, list);
        return { inserted: true };
      },
      updateEnrollment: async (id: string, _orgId: string, patch: EnrollmentPatch) => {
        const enr = this.enrollments.get(id);
        if (!enr) throw new Error("not_found");
        const nextRev = (this.revisions.get(id) ?? 1) + 1;
        this.revisions.set(id, nextRev);
        Object.assign(enr, patch, { revision: nextRev });
      },
      applyEnrollmentStep: async (id: string, orgId: string, patch: EnrollmentPatch, event: {
        node_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        idempotency_key: string;
      }) => {
        const res = await this.getAdminClient().insertEnrollmentEvent({
          organization_id: orgId,
          enrollment_id: id,
          node_id: event.node_id,
          event_type: event.event_type,
          payload: event.payload,
          idempotency_key: event.idempotency_key,
        });
        if (!res.inserted) return false;
        await this.getAdminClient().updateEnrollment(id, orgId, patch);
        return true;
      },
      loadFlowPointerName: async (_orgId: string, _pointerId: string) => {
        return "Fluxo Teste";
      },
      insertDeadInboxItem: async (item: { organization_id: string; title: string; body: string; ref_id: string }) => {
        this.deadItems.push(item);
      },
      persistirRespostaFollowup: async () => {},
      updateLeadTags: async (input: { action: "add" | "remove"; tags: string[] }) => {
        if (input.action === "add") {
          this.leadTags = Array.from(new Set([...this.leadTags, ...input.tags]));
        } else {
          this.leadTags = this.leadTags.filter((t) => !input.tags.includes(t));
        }
      },
      updateLeadStage: async (input: { stage_id: string }) => {
        this.leadStage = input.stage_id;
      },
      enqueueJob: async (job: FollowupJobRequest) => {
        this.jobSeq += 1;
        this.queue.push({
          id: `job-${this.jobSeq}`,
          organization_id: job.organization_id,
          contact_id: job.contact_id,
          payload: job.payload,
          run_after: job.run_after,
        });
      },
    };
  }

  getTickDeps(): TickDeps {
    const admin = this.getAdminClient();
    return {
      db: admin,
      clock: this.clock,
      enqueueJob: admin.enqueueJob!,
    };
  }

  /** Simula o worker executando todos os jobs enfileirados que estejam prontos (run_after <= now). */
  async drainWorker(maxIterations = 20): Promise<{ jobsProcessed: number }> {
    let count = 0;
    const admin = this.getAdminClient();

    while (count < maxIterations) {
      const now = this.clock();
      const readyIdx = this.queue.findIndex(
        (j) => !j.run_after || j.run_after <= now,
      );
      if (readyIdx === -1) break;

      count++;
      const [job] = this.queue.splice(readyIdx, 1);
      if (!job) break;

      const enrollmentId = job.payload.followup_enrollment_id as string;
      const nodeId = job.payload.node_id as string;
      const purpose = job.payload.purpose as string | undefined;

      if (purpose === "wait_wake") {
        await completeTurnForEnrollment(
          admin,
          job.organization_id,
          enrollmentId,
          nodeId,
          { kind: "wake" },
          this.clock,
          job.id,
        );
      } else {
        await completeTurnForEnrollment(
          admin,
          job.organization_id,
          enrollmentId,
          nodeId,
          { kind: "sent" },
          this.clock,
          job.id,
        );
      }
    }
    return { jobsProcessed: count };
  }
}

describe("Follow-up Event-Driven Latency Tests", () => {
  // ── Cenário A ─────────────────────────────────────────────────────────────
  it("Cenário A: Trigger → Texto → Imagem → Imagem → Áudio → Fim avança imediatamente em segundos sem esperar cron", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "msg_text", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Olá" } },
        { id: "msg_img1", type: "message_image", label: "Imagem 1", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/1.png" } },
        { id: "msg_img2", type: "message_image", label: "Imagem 2", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/2.png" } },
        { id: "msg_aud", type: "message_audio", label: "Áudio", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/1.mp3" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "msg_text", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "msg_text", target: "msg_img1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "msg_img1", target: "msg_img2", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "msg_img2", target: "msg_aud", priority: 0, condition: { type: "always" } },
        { id: "e4", source: "msg_aud", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    const startTime = harness.clock().getTime();

    // 1. Inscrição dispara avanço imediato
    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);

    // Trigger avançou e Texto foi enfileirado imediatamente
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.node_id).toBe("msg_text");

    // 2. Drena a fila através dos turnos sucessivos
    const { jobsProcessed } = await harness.drainWorker();

    // Foram 4 jobs de envio: Texto, Imagem 1, Imagem 2, Áudio
    expect(jobsProcessed).toBe(4);
    expect(harness.queue.length).toBe(0);

    // O fluxo chegou ao fim e concluiu
    const finalEnr = harness.enrollments.get(enr.id)!;
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.outcome).toBe("converted");
    expect(finalEnr.completed_at).not.toBeNull();

    // Tempo de cron decorrido: ZERO ms de espera de agendamento!
    const endTime = harness.clock().getTime();
    expect(endTime - startTime).toBe(0);
  });

  // ── Cenário B ─────────────────────────────────────────────────────────────
  it("Cenário B: Trigger → Texto → Delay 60s → Imagem → Fim respeita exatamente os 60s do delay", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "msg_text", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Aguarde..." } },
        { id: "dly_60", type: "delay", label: "Delay 60s", position: { x: 0, y: 0 }, config: { duration_value: 1, unit: "minutes" } },
        { id: "msg_img", type: "message_image", label: "Imagem", position: { x: 0, y: 0 }, config: { media_url: "https://example.com/promo.png" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "msg_text", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "msg_text", target: "dly_60", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "dly_60", target: "msg_img", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "msg_img", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    // 1. Início imediato: Texto enfileirado
    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.node_id).toBe("msg_text");

    // 2. Processa envio do texto -> cai no delay de 60s
    await harness.drainWorker();

    const enrWaiting = harness.enrollments.get(enr.id)!;
    expect(enrWaiting.current_node_id).toBe("dly_60");
    expect(enrWaiting.status).toBe("active");
    // next_eval_at deve ser exatamente agora + 60s
    const expectedEvalAt = new Date(harness.currentTime + 60_000).toISOString();
    expect(enrWaiting.next_eval_at).toBe(expectedEvalAt);

    // 3. Antes dos 60s (ex: 59s): cron tick não deve avançar o delay
    harness.advanceTime(59_000);
    const tickSummaryBefore = await runFollowupTick(harness.getTickDeps());
    expect(tickSummaryBefore.claimed).toBe(0);
    expect(harness.enrollments.get(enr.id)!.current_node_id).toBe("dly_60");
    // O job temporal de wait_wake está agendado na fila
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.purpose).toBe("wait_wake");

    // 4. Aos 60s exatos: cron tick acorda o delay e avança para a imagem; próximo tick avalia e enfileira
    harness.advanceTime(1_000); // completou 60s
    const tickSummaryAfter = await runFollowupTick(harness.getTickDeps());
    expect(tickSummaryAfter.claimed).toBe(1);
    await runFollowupTick(harness.getTickDeps());

    // Imagem foi enfileirada!
    expect(harness.queue.some((j) => j.payload.node_id === "msg_img")).toBe(true);

    // 5. Worker conclui a imagem -> fluxo finalizado
    await harness.drainWorker();
    const enrDone = harness.enrollments.get(enr.id)!;
    expect(enrDone.status).toBe("completed");
    expect(enrDone.outcome).toBe("converted");
  });

  // ── Cenário C ─────────────────────────────────────────────────────────────
  it("Cenário C: Trigger → Texto → Typing 5s → Texto 2 → Fim respeita os 5s de digitação", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "t1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "Digitando..." } },
        { id: "typ_5", type: "typing", label: "Typing 5s", position: { x: 0, y: 0 }, config: { duration_seconds: 5 } },
        { id: "t2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "Pronto!" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "t1", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "t1", target: "typ_5", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "typ_5", target: "t2", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "t2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    // 1. Início imediato: Texto 1 enfileirado
    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);
    expect(harness.queue.length).toBe(1);

    // 2. Envia Texto 1 -> entra em typing de 5s
    await harness.drainWorker();
    const enrTyping = harness.enrollments.get(enr.id)!;
    expect(enrTyping.current_node_id).toBe("typ_5");
    expect(enrTyping.next_eval_at).toBe(new Date(harness.currentTime + 5_000).toISOString());

    // 3. Antes dos 5s (ex: 4s): não acorda
    harness.advanceTime(4_000);
    await runFollowupTick(harness.getTickDeps());
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.purpose).toBe("wait_wake");

    // 4. Aos 5s: acorda e avança para Texto 2; próximo tick avalia e enfileira
    harness.advanceTime(1_000);
    await runFollowupTick(harness.getTickDeps());
    await runFollowupTick(harness.getTickDeps());
    expect(harness.queue.some((j) => j.payload.node_id === "t2")).toBe(true);

    // 5. Worker envia Texto 2 -> conclui
    await harness.drainWorker();
    expect(harness.enrollments.get(enr.id)!.status).toBe("completed");
  });

  // ── Cenário D ─────────────────────────────────────────────────────────────
  it("Cenário D: Trigger → Condition → Tag → Stage_move → Texto → Fim avança todos os nodes síncronos na mesma execução", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        {
          id: "cond",
          type: "condition",
          label: "Condição",
          position: { x: 0, y: 0 },
          config: {
            combinator: "and",
            checks: [{ field: "steps_taken", op: "gte", value: 0 }],
          },
        },
        { id: "tag_node", type: "tag", label: "Adicionar Tag", position: { x: 0, y: 0 }, config: { action: "add", tags: ["vip", "novo"] } },
        { id: "stage_node", type: "stage_move", label: "Mover Etapa", position: { x: 0, y: 0 }, config: { pipeline_id: "11111111-1111-4111-8111-111111111111", stage_id: "22222222-2222-4222-8222-222222222222" } },
        { id: "msg_text", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Bem-vindo!" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "cond", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "cond", target: "tag_node", priority: 0, condition: { type: "cond_result", value: true } },
        { id: "e2", source: "tag_node", target: "stage_node", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "stage_node", target: "msg_text", priority: 0, condition: { type: "always" } },
        { id: "e4", source: "msg_text", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    // Invocação única de avanço imediato
    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);

    // Efeitos colaterais dos nodes síncronos foram aplicados na mesma passada:
    expect(harness.leadTags).toEqual(["vip", "novo"]);
    expect(harness.leadStage).toBe("22222222-2222-4222-8222-222222222222");

    // E o primeiro node assíncrono (Texto) já foi enfileirado imediatamente:
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.node_id).toBe("msg_text");

    // O enrollment parou no nó de mensagem com steps_taken acumulado de todos os passos anteriores
    const currentEnr = harness.enrollments.get(enr.id)!;
    expect(currentEnr.current_node_id).toBe("msg_text");
    expect(currentEnr.steps_taken).toBe(5); // trg(1) -> cond(2) -> tag(3) -> stage(4) -> msg_text(5)
  });

  // ── Cenário E ─────────────────────────────────────────────────────────────
  it("Cenário E: Crash do worker não perde o fluxo — dead-man recheck (next_eval_at) permite ao cron recuperar", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "msg_text", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "Olá" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "msg_text", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "msg_text", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);
    expect(harness.queue.length).toBe(1);

    // Simula CRASH: o job foi removido da fila mas o worker caiu e NUNCA chamou completeTurnForEnrollment
    harness.queue.shift();

    const enrAfterCrash = harness.enrollments.get(enr.id)!;
    expect(enrAfterCrash.current_node_id).toBe("msg_text");
    expect(enrAfterCrash.status).toBe("active");
    // next_eval_at foi configurado para now + 5 min (ACTION_RECHECK_MS) como dead-man
    const nextEvalTime = new Date(enrAfterCrash.next_eval_at!).getTime();
    expect(nextEvalTime).toBeGreaterThan(harness.currentTime);

    // Avança o tempo até o dead-man disparar (5 minutos)
    harness.advanceTime(5 * 60 * 1000 + 1000);

    // O cron acorda e reinvindica o enrollment abandonado
    const tickSummary = await runFollowupTick(harness.getTickDeps());
    expect(tickSummary.claimed).toBe(1);

    // O enrollment continua vivo e sob monitoramento
    const enrRecovered = harness.enrollments.get(enr.id)!;
    expect(enrRecovered.status).toBe("active");
  });

  // ── Cenário F ─────────────────────────────────────────────────────────────
  it("Cenário F: Idempotência — chamadas repetidas ou replays de turno NÃO duplicam jobs", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "msg_1", type: "message_text", label: "Texto 1", position: { x: 0, y: 0 }, config: { body: "T1" } },
        { id: "msg_2", type: "message_text", label: "Texto 2", position: { x: 0, y: 0 }, config: { body: "T2" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "msg_1", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "msg_1", target: "msg_2", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "msg_2", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);
    expect(harness.queue.length).toBe(1);

    const job = harness.queue.shift()!;
    const admin = harness.getAdminClient();

    // 1ª conclusão legítima de msg_1
    await completeTurnForEnrollment(
      admin,
      enr.organization_id,
      enr.id,
      "msg_1",
      { kind: "sent" },
      harness.clock,
      job.id,
    );
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.node_id).toBe("msg_2");

    // 2ª chamada REPLAY com o mesmo turno/passo
    await completeTurnForEnrollment(
      admin,
      enr.organization_id,
      enr.id,
      "msg_1",
      { kind: "sent" },
      harness.clock,
      job.id,
    );

    // NÃO enfileirou um segundo job para msg_2! A contagem continua 1!
    expect(harness.queue.length).toBe(1);
  });

  // ── Cenário G ─────────────────────────────────────────────────────────────
  it("Cenário G: Eventos — nenhum evento duplicado gravado no histórico", async () => {
    const harness = new InMemoryHarness();
    const admin = harness.getAdminClient();

    const ev1 = await admin.insertEnrollmentEvent({
      organization_id: "org-1",
      enrollment_id: "enr-1",
      node_id: "node-1",
      event_type: "action_sent",
      payload: {},
      idempotency_key: "node-1:1",
    });
    expect(ev1.inserted).toBe(true);

    // Tentativa duplicada com a mesma idempotency_key
    const ev2 = await admin.insertEnrollmentEvent({
      organization_id: "org-1",
      enrollment_id: "enr-1",
      node_id: "node-1",
      event_type: "action_sent",
      payload: {},
      idempotency_key: "node-1:1",
    });
    expect(ev2.inserted).toBe(false);

    const events = await admin.loadEnrollmentEvents("enr-1");
    expect(events.length).toBe(1);
  });

  // ── Cenário H ─────────────────────────────────────────────────────────────
  it("Cenário H: Compatibilidade total com nó action legado", async () => {
    const harness = new InMemoryHarness();
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Trigger", position: { x: 0, y: 0 }, config: {} },
        { id: "act_legacy", type: "action", label: "Ação Legada", position: { x: 0, y: 0 }, config: { mode: "ai_message", prompt_hint: "Olá" } },
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e0", source: "trg", target: "act_legacy", priority: 0, condition: { type: "always" } },
        { id: "e1", source: "act_legacy", target: "end", priority: 0, condition: { type: "always" } },
      ],
    };
    harness.graphs.set("ver-test", graph);
    const enr = harness.createEnrollment({ current_node_id: "trg" });

    // 1. Início imediato
    await avancarEnrollmentAtivo(harness.getTickDeps(), enr);
    expect(harness.queue.length).toBe(1);
    expect(harness.queue[0]?.payload.node_id).toBe("act_legacy");
    expect(harness.queue[0]?.payload.purpose).toBe("send_message");

    // 2. Conclusão do turno legado
    const { jobsProcessed } = await harness.drainWorker();
    expect(jobsProcessed).toBe(1);

    // Conforme contrato canônico tradicional (agenda-presenca-fix1 e followup-engine),
    // a conclusão do turno avança o ponteiro para o nó alvo ('end') mantendo status 'active'
    const enrAfterTurn = harness.enrollments.get(enr.id)!;
    expect(enrAfterTurn.current_node_id).toBe("end");
    expect(enrAfterTurn.status).toBe("active");
    expect(enrAfterTurn.steps_taken).toBe(3);

    // O próximo tick conclui o nó 'end'
    await runFollowupTick(harness.getTickDeps());
    const finalEnr = harness.enrollments.get(enr.id)!;
    expect(finalEnr.status).toBe("completed");
    expect(finalEnr.outcome).toBe("converted");
  });
});

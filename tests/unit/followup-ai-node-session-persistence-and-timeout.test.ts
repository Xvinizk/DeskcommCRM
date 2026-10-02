import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runFollowupTick,
  type FollowupJobRequest,
  type TickDeps,
  type AdminClient,
} from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow, LeadFacts } from "@/lib/followup/node-handlers";
import type { AiNodeSession } from "@/lib/followup/ai-node-session";

const RAIZ = join(__dirname, "../..");
const BASELINE_SQL = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");
const MIGRATION_0386_SQL = readFileSync(
  join(RAIZ, "supabase/migrations/20261002060000_0386_followup_patch_ai_node_session.sql"),
  "utf8",
);
const MIGRATION_0245_SQL = readFileSync(
  join(RAIZ, "supabase/migrations/20260914195200_0245_followup_stale_nao_e_retry.sql"),
  "utf8",
);

interface MockEnrollment extends Omit<EnrollmentRow, "ai_node_session"> {
  ai_node_session: AiNodeSession | null;
}

/**
 * Simula a execução de fn_followup_patch no Postgres.
 *
 * No SQL real:
 * select * into patched from jsonb_populate_record(current, p_patch);
 * update public.followup_enrollments set ...
 */
function simulatePgFollowupPatch(
  current: MockEnrollment,
  patch: Record<string, unknown>,
  mode: "buggy_0245" | "fixed_0386",
): MockEnrollment {
  // jsonb_populate_record: campos em patch sobrescrevem current
  const patched = { ...current, ...patch } as Record<string, unknown>;

  if (mode === "buggy_0245") {
    // Definição antiga da migration 0245: NÃO incluía ai_node_session no UPDATE!
    return {
      ...current,
      status: patched.status as MockEnrollment["status"],
      current_node_id: patched.current_node_id as string,
      next_eval_at: patched.next_eval_at as string | null,
      claimed_until: patched.claimed_until as string | null,
      attempts: patched.attempts as number,
      last_error: patched.last_error as string | null,
      steps_taken: patched.steps_taken as number,
      outcome: patched.outcome as MockEnrollment["outcome"],
      cancel_reason: patched.cancel_reason as string | null,
      completed_at: patched.completed_at as string | null,
      timing_plan: patched.timing_plan as MockEnrollment["timing_plan"],
      // ai_node_session NÃO é atualizado (fica o valor de current, que é null no início)
      ai_node_session: current.ai_node_session ?? null,
      updated_at: new Date().toISOString(),
    };
  }

  // Definição corrigida da migration 0386 / baseline atual:
  return {
    ...current,
    status: patched.status as MockEnrollment["status"],
    current_node_id: patched.current_node_id as string,
    next_eval_at: patched.next_eval_at as string | null,
    claimed_until: patched.claimed_until as string | null,
    attempts: patched.attempts as number,
    last_error: patched.last_error as string | null,
    steps_taken: patched.steps_taken as number,
    outcome: patched.outcome as MockEnrollment["outcome"],
    cancel_reason: patched.cancel_reason as string | null,
    completed_at: patched.completed_at as string | null,
    timing_plan: patched.timing_plan as MockEnrollment["timing_plan"],
    // ai_node_session É atualizado a partir de patched!
    ai_node_session: (patched.ai_node_session as AiNodeSession | null) ?? null,
    updated_at: new Date().toISOString(),
  };
}

class AiNodeHarness {
  currentTime = new Date("2026-10-02T10:00:00.000Z").getTime();
  enrollment: MockEnrollment;
  events: EnrollmentEventRef[] = [];
  jobs: FollowupJobRequest[] = [];
  graph: FlowGraph;
  patchMode: "buggy_0245" | "fixed_0386";

  constructor(patchMode: "buggy_0245" | "fixed_0386") {
    this.patchMode = patchMode;

    // Estado inicial obrigatório: ai_node_session = NULL
    this.enrollment = {
      id: "ff282e06-c43a-4287-87a7-76035b544dd8",
      organization_id: "org-test-node-ia",
      pointer_id: "ptr-test",
      version_id: "ver-test",
      contact_id: "contact-test",
      conversation_id: "conv-test",
      service_boundary: null,
      revision: 1,
      appointment_id: null,
      appointment_revision: null,
      current_node_id: "ai_node_1",
      status: "active",
      next_eval_at: new Date(this.currentTime).toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 0,
      outcome: null,
      cancel_reason: null,
      started_at: new Date(this.currentTime).toISOString(),
      completed_at: null,
      updated_at: new Date(this.currentTime).toISOString(),
      timing_plan: null,
      ai_node_session: null, // NULL inicial!
    };

    this.graph = {
      nodes: [
        {
          id: "ai_node_1",
          type: "ai_node",
          label: "Atendimento IA",
          position: { x: 0, y: 0 },
          config: {
            mode: "existing_agent",
            timeout: { duration_value: 15, unit: "minutes" }, // 15 minutos de inatividade
            agent_binding: {
              agent_id: "a0000000-0000-0000-0000-000000000001",
              version_strategy: "published",
            },
          },
        },
        {
          id: "end_timeout",
          type: "end",
          label: "Fim por Timeout",
          position: { x: 100, y: 100 },
          config: { outcome: "exhausted" },
        },
      ],
      edges: [
        {
          id: "edge_timeout",
          source: "ai_node_1",
          target: "end_timeout",
          priority: 0,
          condition: { type: "branch", branch_id: "timeout" },
        },
      ],
    };
  }

  clock = (): Date => new Date(this.currentTime);

  advanceTime(ms: number) {
    this.currentTime += ms;
  }

  getTickDeps(): TickDeps {
    return {
      clock: this.clock,
      enqueueJob: async (job: FollowupJobRequest) => {
        this.jobs.push(job);
      },
      db: {
        claimDueEnrollments: async (limit: number, leaseSeconds: number) => {
          const now = this.clock();
          if (
            this.enrollment.status === "active" &&
            this.enrollment.next_eval_at &&
            new Date(this.enrollment.next_eval_at) <= now &&
            (!this.enrollment.claimed_until || new Date(this.enrollment.claimed_until) <= now)
          ) {
            this.enrollment.claimed_until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
            return [{ ...(this.enrollment as unknown as EnrollmentRow) }];
          }
          return [];
        },
        loadEnrollmentById: async () => ({ ...(this.enrollment as unknown as EnrollmentRow) }),
        loadFlowGraph: async () => JSON.parse(JSON.stringify(this.graph)),
        loadLeadFacts: async (): Promise<LeadFacts> => ({
          lead_stage: null,
          tags: [],
          steps_taken: 0,
          last_outcome: null,
          contact_name: "Cliente Teste",
          custom_fields: {},
        }),
        loadEnrollmentEvents: async () => [...this.events],
        loadLastInboundBody: async () => null,
        insertEnrollmentEvent: async (event: {
          node_id: string;
          event_type: string;
          payload: Record<string, unknown>;
          idempotency_key: string;
        }) => {
          const exists = this.events.some((e) => e.idempotency_key === event.idempotency_key);
          if (exists) return { inserted: false };
          this.events.push({
            node_id: event.node_id,
            event_type: event.event_type,
            payload: event.payload,
            idempotency_key: event.idempotency_key,
          });
          return { inserted: true };
        },
        updateEnrollment: async (_id: string, _orgId: string, patch: Record<string, unknown>) => {
          // Passa pelo simulador do Postgres fn_followup_patch
          this.enrollment = simulatePgFollowupPatch(this.enrollment, patch, this.patchMode);
        },
        applyEnrollmentStep: async (
          _id: string,
          _orgId: string,
          patch: Record<string, unknown>,
          event: {
            node_id: string;
            event_type: string;
            payload: Record<string, unknown>;
            idempotency_key: string;
          },
        ) => {
          this.events.push({
            node_id: event.node_id,
            event_type: event.event_type,
            payload: event.payload,
            idempotency_key: event.idempotency_key,
          });
          this.enrollment = simulatePgFollowupPatch(this.enrollment, patch, this.patchMode);
          return true;
        },
        enqueueJob: async (job: FollowupJobRequest) => {
          this.jobs.push(job);
        },
        loadFlowPointerName: async () => "Fluxo E2E",
        insertDeadInboxItem: async () => {},
        persistirRespostaFollowup: async () => {},
      } as unknown as AdminClient,
    };
  }
}

describe("Regressão Bug B: Persistência de ai_node_session e Resiliência a Timeout", () => {
  const origEnv = process.env.FOLLOWUP_AI_NODE_ENABLED;

  beforeEach(() => {
    process.env.FOLLOWUP_AI_NODE_ENABLED = "true";
  });

  afterEach(() => {
    process.env.FOLLOWUP_AI_NODE_ENABLED = origEnv;
  });

  it("1. Verificação Estática de SQL: fn_followup_patch possui ai_node_session = patched.ai_node_session na 0386 e baseline", () => {
    // 0386 possui a persistência
    expect(MIGRATION_0386_SQL).toContain("ai_node_session=patched.ai_node_session");
    expect(MIGRATION_0386_SQL).toContain("create or replace function public.fn_followup_patch");

    // baseline.sql possui a persistência
    expect(BASELINE_SQL).toContain("ai_node_session=patched.ai_node_session");

    // 0245 antiga NÃO possuía (reprodução do código histórico com defeito)
    expect(MIGRATION_0245_SQL).not.toContain("ai_node_session=patched.ai_node_session");
  });

  it("2. Reprodução do Bug B no código antigo (0245): ai_node_session é descartado e vira NULL no banco", async () => {
    const harness = new AiNodeHarness("buggy_0245");
    expect(harness.enrollment.ai_node_session).toBeNull();

    // Tick 1: Entrada inicial no Node IA
    const summary1 = await runFollowupTick(harness.getTickDeps());
    expect(summary1.claimed).toBe(1);

    // No código antigo, fn_followup_patch descartava ai_node_session:
    // O banco continuava com ai_node_session = NULL!
    expect(harness.enrollment.ai_node_session).toBeNull();
  });

  it("3. Correção do Bug B (0386): ai_node_session é persistido como JSON NÃO-NULL com status running", async () => {
    const harness = new AiNodeHarness("fixed_0386");
    expect(harness.enrollment.ai_node_session).toBeNull();

    // Tick 1: Entrada inicial no Node IA
    const summary1 = await runFollowupTick(harness.getTickDeps());
    expect(summary1.claimed).toBe(1);

    // Após persistência via caminho real corrigido:
    // SELECT followup_enrollments.ai_node_session DEVE retornar JSON NÃO NULL com a sessão running!
    const session = harness.enrollment.ai_node_session;
    expect(session).not.toBeNull();
    expect(session?.status).toBe("running");
    expect(session?.node_id).toBe("ai_node_1");
    expect(session?.started_at).toBeDefined();
    expect(session?.timeout_at).toBeDefined();

    // Deadline calculada para 15 minutos no futuro (10:15)
    const expectedDeadline = new Date("2026-10-02T10:15:00.000Z").toISOString();
    expect(session?.timeout_at).toBe(expectedDeadline);
    expect(harness.enrollment.next_eval_at).toBe(expectedDeadline);
  });

  it("4. Prova de Resiliência: wake com deadline futura NÃO sai por timeout", async () => {
    const harness = new AiNodeHarness("fixed_0386");

    // Tick 1: Entra no Node IA e persiste a sessão
    await runFollowupTick(harness.getTickDeps());
    expect(harness.enrollment.ai_node_session?.status).toBe("running");

    // Simula passagem de 2 minutos apenas (10:02) — deadline ainda é 10:15
    harness.advanceTime(2 * 60 * 1000);

    // Simula evento inbound_woke ou wake que acorda o enrollment antes da hora
    harness.enrollment.next_eval_at = harness.clock().toISOString();

    // Executa tick
    const summary2 = await runFollowupTick(harness.getTickDeps());
    expect(summary2.claimed).toBe(1);

    // Prova: NÃO sai por timeout!
    // Permanece em ai_node_1, status active, e deadline é preservada em 10:15
    expect(harness.enrollment.current_node_id).toBe("ai_node_1");
    expect(harness.enrollment.status).toBe("active");
    expect(harness.enrollment.cancel_reason).toBeNull();
    expect(harness.enrollment.outcome).toBeNull();

    // Evento registrado prova que o timeout stale/prematuro foi ignorado
    const staleIgnored = harness.events.find((e) => e.event_type === "ai_node.timeout_stale_ignored");
    expect(staleIgnored).toBeDefined();
  });

  it("5. Teste de Timeout Normal (Seção 8): deadline vencida dispara timeout branch EXATAMENTE UMA VEZ", async () => {
    const harness = new AiNodeHarness("fixed_0386");

    // Tick 1: Entra no Node IA às 10:00 (deadline = 10:15)
    await runFollowupTick(harness.getTickDeps());
    expect(harness.enrollment.ai_node_session?.status).toBe("running");

    // Cenário A: deadline futuro (10:10) -> NÃO timeout
    harness.advanceTime(10 * 60 * 1000);
    harness.enrollment.next_eval_at = harness.clock().toISOString();
    await runFollowupTick(harness.getTickDeps());
    expect(harness.enrollment.current_node_id).toBe("ai_node_1");

    // Cenário B: avança o relógio para 10:16 (passou de 10:15) -> deadline VENCIDO
    harness.advanceTime(6 * 60 * 1000); // 10:16
    harness.enrollment.next_eval_at = harness.clock().toISOString();

    const summaryTimeout = await runFollowupTick(harness.getTickDeps());
    expect(summaryTimeout.claimed).toBe(1);

    // O timeout branch é acionado com sucesso: avança para end_timeout!
    expect(harness.enrollment.current_node_id).toBe("end_timeout");

    // Evento ai_node.timeout registrado
    const timeoutEvents = harness.events.filter((e) => e.event_type === "ai_node.timeout");
    expect(timeoutEvents.length).toBe(1);

    // Evento ai_node.exited registrado
    const exitedEvents = harness.events.filter((e) => e.event_type === "ai_node.exited");
    expect(exitedEvents.length).toBe(1);
    const exitedPayload = exitedEvents[0]?.payload as { branch?: string };
    expect(exitedPayload.branch).toBe("timeout");

    // Sessão marcada como timeout
    expect(harness.enrollment.ai_node_session?.status).toBe("timeout");

    // Tick seguinte: o nó 'end' é processado e concluído
    const summaryEnd = await runFollowupTick(harness.getTickDeps());
    expect(summaryEnd.claimed).toBe(1);
    expect(harness.enrollment.status).toBe("completed");
    expect(harness.enrollment.outcome).toBe("exhausted");

    // Nenhum segundo evento de timeout é gerado (idempotência e fechamento de ciclo)
    const timeoutEventsAfter = harness.events.filter((e) => e.event_type === "ai_node.timeout");
    expect(timeoutEventsAfter.length).toBe(1);
  });
});

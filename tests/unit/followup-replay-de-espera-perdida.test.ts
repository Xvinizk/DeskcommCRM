/**
 * Inscrição presa para sempre quando o UPDATE de uma espera se perde.
 *
 * Medido em produção (VPS, 2026-10-22): 3 inscrições `active` com `next_eval_at`
 * de 14/10, reivindicadas a cada tick (`followup.worker_run` com
 * `claimed: 3, advanced: 0, failed: 0` por 8 dias seguidos) sem nunca avançar.
 *
 * A sequência que as prendeu: dois caminhos processaram a mesma inscrição ao
 * mesmo tempo (o despertar por inbound e o tick — `inbound_woke` e
 * `wait_started` gravados com 24 ms de diferença). Um deles gravou o evento
 * `wait_started` com a chave `<nó>:<passos>`, e o UPDATE que viria em seguida
 * perdeu o CAS de revisão (`fn_followup_patch`). O evento ficou; o estado não.
 *
 * Daí em diante todo tick calcula `advance` para o mesmo nó com a MESMA chave
 * `<nó>:<passos>`, perde o insert para o `wait_started` e o `applyResult`
 * retornava sem gravar nada — sem falha, sem avanço, sem mexer no relógio.
 */
import { describe, expect, it } from "vitest";

import type { FollowupJobRequest } from "@/lib/followup/engine";
import { runFollowupTick } from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import type { TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";

const NOW = new Date("2026-10-22T01:40:00.000Z");
const clock = () => NOW;

const GRAFO: FlowGraph = {
  nodes: [
    { id: "typing-2", type: "typing", label: "Digitando", position: { x: 0, y: 0 }, config: { duration_seconds: 3 } },
    { id: "end-3", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "custom", note: "fim" } },
  ],
  edges: [{ id: "e1", source: "typing-2", target: "end-3", priority: 0, condition: { type: "always" } }],
};

function inscricaoPresa(): EnrollmentRow {
  return {
    id: "enr-preso",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "cont-1",
    conversation_id: "conv-1",
    current_node_id: "typing-2",
    status: "active",
    next_eval_at: "2026-10-14T19:54:03.543Z",
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: "2026-10-14T12:59:29.529Z",
    completed_at: null,
    updated_at: "2026-10-14T12:59:29.529Z",
  };
}

function harness() {
  let enrollment = inscricaoPresa();
  // Os eventos exatos da inscrição edf42fe2 em produção.
  const events = [
    { node_id: "typing-2", event_type: "typing_started", payload: { duration_seconds: 3 }, idempotency_key: "typing-2:1:typing_started" },
    { node_id: "typing-2", event_type: "inbound_woke", payload: {}, idempotency_key: "typing-2:1:wake" },
    { node_id: "typing-2", event_type: "wait_started", payload: { next_eval_at: "2026-10-14T12:59:37.016Z" }, idempotency_key: "typing-2:1" },
    { node_id: "typing-2", event_type: "typing_stopped", payload: {}, idempotency_key: "typing-2:1:typing_stopped" },
  ];
  const jobs: FollowupJobRequest[] = [];
  const db: TurnBridgeAdminClient = {
    claimDueEnrollments: async () =>
      enrollment.status === "active" && new Date(enrollment.next_eval_at!).getTime() <= NOW.getTime() ? [{ ...enrollment }] : [],
    loadEnrollmentById: async () => ({ ...enrollment }),
    loadFlowGraph: async () => GRAFO,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadLastInboundBody: async () => null,
    loadEnrollmentEvents: async () => events.map((e) => ({ ...e })),
    insertEnrollmentEvent: async (event) => {
      if (events.some((e) => e.idempotency_key === event.idempotency_key)) return { inserted: false };
      events.push({ node_id: event.node_id!, event_type: event.event_type, payload: event.payload, idempotency_key: event.idempotency_key! });
      return { inserted: true };
    },
    updateEnrollment: async (_id, _org, patch) => {
      enrollment = { ...enrollment, ...patch };
    },
    loadFlowPointerName: async () => "Oferta",
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
    enqueueJob: async (job) => {
      jobs.push(job);
    },
  };
  return { deps: { db, clock, enqueueJob: db.enqueueJob! }, get: () => enrollment, events };
}

describe("followup — espera cujo UPDATE se perdeu não prende a inscrição", () => {
  it("o tick recompõe o passo da espera perdida e a inscrição volta a andar", async () => {
    const h = harness();

    // recompõe o passo → typing avança para o end → end conclui (o tick não cascateia)
    await runFollowupTick(h.deps);
    await runFollowupTick(h.deps);
    await runFollowupTick(h.deps);

    expect(h.get().current_node_id).toBe("end-3");
    expect(h.get().status).toBe("completed");
  });

  it("o primeiro tick aplica exatamente o patch que a espera perdida teria aplicado", async () => {
    const h = harness();

    await runFollowupTick(h.deps);

    expect(h.get().current_node_id).toBe("typing-2");
    expect(h.get().steps_taken).toBe(2);
    expect(h.get().next_eval_at).toBe("2026-10-14T12:59:37.016Z");
    // nenhum evento novo com a chave queimada — o histórico não é reescrito
    expect(h.events.filter((e) => e.idempotency_key === "typing-2:1")).toHaveLength(1);
  });
});

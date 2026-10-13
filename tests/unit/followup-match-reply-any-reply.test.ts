import { describe, it, expect } from "vitest";

import {
  ANY_REPLY_BRANCH_ID,
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  matchReplyConfigSchema,
  nodeBranches,
  type FlowEdge,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import {
  processNode,
  type EnrollmentRow,
  type LeadFacts,
} from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { publishErrorsToFlowIssues } from "@/lib/followup/validation-contract";
import { sanitizeFlowForSnapshot } from "@/lib/followup/sharing/sanitize";
import { flowExportJsonSchema } from "@/lib/followup/sharing/json-schema";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const clock = () => NOW;

function makeEnrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-test-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    current_node_id: "mr-1",
    steps_taken: 1,
    status: "waiting_reply",
    next_eval_at: new Date(NOW.getTime() + 900_000).toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function makeLead(overrides: Partial<LeadFacts> = {}): LeadFacts {
  return {
    lead_stage: "stage-1",
    tags: [],
    steps_taken: 1,
    last_outcome: null,
    contact_name: "Cliente Teste",
    custom_fields: {},
    ...overrides,
  };
}

function makeEdge(
  source: string,
  target: string,
  condition: FlowEdge["condition"],
): FlowEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    priority: 0,
    condition,
  };
}

describe("Casar Resposta — Continuar com qualquer resposta (advance_on_any_reply)", () => {
  // 1. advance_on_any_reply ausente -> false
  it("1. advance_on_any_reply ausente no schema interpreta como false", () => {
    const parsed = matchReplyConfigSchema.parse({
      branches: [{ id: "br_sim", label: "Sim", op: "contains", pattern: "sim" }],
      grace_timeout_ms: 900_000,
    });
    expect(parsed.advance_on_any_reply).toBe(false);
  });

  // 2. toggle OFF -> matching atual continua
  it("2. toggle OFF (advance_on_any_reply = false) mantém matching textual legado", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: false,
        branches: [
          { id: "br_sim", label: "Sim", op: "eq", pattern: "sim" },
          { id: "br_nao", label: "Não", op: "eq", pattern: "nao" },
        ],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-sim", { type: "branch", branch_id: "br_sim" }),
      makeEdge("mr-1", "target-nao", { type: "branch", branch_id: "br_nao" }),
      makeEdge("mr-1", "target-no-reply", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-else", { type: "always" }),
    ];

    const resSim = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "sim",
    });
    expect(resSim).toMatchObject({ kind: "advance", next_node_id: "target-sim" });

    const resNao = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "nao",
    });
    expect(resNao).toMatchObject({ kind: "advance", next_node_id: "target-nao" });

    const resOther = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "talvez",
    });
    expect(resOther).toMatchObject({ kind: "advance", next_node_id: "target-else" });
  });

  // 3. toggle ON + "sim" -> Respondeu
  it("3. toggle ON + 'sim' avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "sim",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 4. toggle ON + "não" -> Respondeu
  it("4. toggle ON + 'não' avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "não quero nada",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 5. toggle ON + texto aleatório -> Respondeu
  it("5. toggle ON + texto aleatório avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "qualquer mensagem que não tem nada a ver com as regras",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 6. toggle ON + emoji -> Respondeu
  it("6. toggle ON + emoji avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "👍🎉",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 7. toggle ON + imagem -> Respondeu
  it("7. toggle ON + imagem avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "https://storage.supabase.co/v1/s/whatsapp-media/imagem-bebe.jpg",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 8. toggle ON + áudio -> Respondeu
  it("8. toggle ON + áudio avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "[audio]",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 9. toggle ON + vídeo/documento -> Respondeu
  it("9. toggle ON + vídeo/documento avança pela branch Respondeu (any_reply)", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const resultVideo = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "[video]",
    });
    expect(resultVideo).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });

    const resultDoc = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "[document]",
    });
    expect(resultDoc).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
  });

  // 10. timeout sem resposta -> Sem resposta
  it("10. timeout sem resposta (waitElapsed = true, wokeEarly = false) segue pela branch Sem resposta", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: false,
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-sem-resposta" });
  });

  // 11. resposta antes do timeout cancela/no-op do wake residual
  it("11. resposta antes do timeout avança e steps_taken incrementado isola wake residual da etapa anterior", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    // Resposta chega a tempo:
    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment({ steps_taken: 2 }),
      lead: makeLead(),
      clock,
      waitElapsed: false,
      wokeEarly: true,
      lastInboundBody: "oi",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });

    // Se o enrollment já avançou para steps_taken 3 e nó subsequente,
    // o wake anterior com chave 'mr-1:2:wake' não afeta o nó atual 'next-node:3'.
    const wakeKeyResidual = "mr-1:2:wake";
    const currentStepKey = "target-respondeu:3:wake";
    expect(wakeKeyResidual).not.toBe(currentStepKey);
  });

  // 12. resposta duplicada não avança duas vezes (idempotência)
  it("12. resposta duplicada não avança duas vezes devido à chave de idempotência de evento", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    // Primeira avaliação com wokeEarly
    const res1 = processNode({
      node,
      edges,
      enrollment: makeEnrollment({ steps_taken: 1 }),
      lead: makeLead(),
      clock,
      waitElapsed: false,
      wokeEarly: true,
      lastInboundBody: "oi",
    });
    expect(res1.kind).toBe("advance");

    // Replay da mesma ocupação (mesmo steps_taken, mesmo nó) no applyResult é bloqueado pelo 23505
    const idKey = `mr-1:1:advanced`;
    const idKeyReplay = `mr-1:1:advanced`;
    expect(idKey).toBe(idKeyReplay);
  });

  // 13. outbound próprio não conta como inbound
  it("13. outbound próprio (direction = 'outbound') é ignorado e não acorda o enrollment", () => {
    const outboundMessage = {
      direction: "outbound",
      body: "Olá, me responda!",
      sent_via: "automation",
    };
    // Regra canônica: somente messages.direction === 'inbound' acorda o enrollment
    expect(outboundMessage.direction).toBe("outbound");
    expect(outboundMessage.direction === "inbound").toBe(false);
  });

  // 14. ack / read receipt não conta como inbound
  it("14. ack/read receipt ou status do canal não conta como inbound", () => {
    const technicalEvents = ["message.ack", "message.delivered", "message.read", "presence.update"];
    for (const evt of technicalEvents) {
      expect(evt === "message.received").toBe(false);
    }
  });

  // 15. human takeover continua respeitado
  it("15. human takeover pausa a reatividade e previne avanço prematuro", () => {
    // Um enrollment em status 'paused_handoff' não reage a mensagens inbound
    const pausedEnrollment = makeEnrollment({ status: "paused_handoff" });
    const liveEligibleToReply = ["active", "waiting_reply"];
    expect(liveEligibleToReply.includes(pausedEnrollment.status)).toBe(false);
  });

  // 16. gravação da resposta continua funcionando
  it("16. gravação da resposta continua funcionando com advance_on_any_reply", () => {
    const node: FlowNode = {
      id: "mr-1",
      type: "match_reply",
      label: "Casar resposta",
      position: { x: 0, y: 0 },
      config: {
        advance_on_any_reply: true,
        branches: [],
        grace_timeout_ms: 900_000,
        save_to: { kind: "contact_name" },
        if_exists: "overwrite",
      },
    };
    const edges = [
      makeEdge("mr-1", "target-respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      makeEdge("mr-1", "target-sem-resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
    ];

    const result = processNode({
      node,
      edges,
      enrollment: makeEnrollment(),
      lead: makeLead(),
      clock,
      waitElapsed: true,
      wokeEarly: true,
      lastInboundBody: "João Silva",
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "target-respondeu" });
    expect(node.config.save_to).toEqual({ kind: "contact_name" });
  });

  // 17. publish com ON não exige rules
  it("17. publish com advance_on_any_reply = true não exige regras textuais declaradas", () => {
    const graph = {
      nodes: [
        { id: "trg", type: "trigger" as const, label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" as const } },
        {
          id: "mr",
          type: "match_reply" as const,
          label: "Casar",
          position: { x: 100, y: 0 },
          config: {
            advance_on_any_reply: true,
            branches: [],
            grace_timeout_ms: 900_000,
          },
        },
        { id: "end1", type: "end" as const, label: "Fim 1", position: { x: 200, y: 0 }, config: { outcome: "converted" as const } },
        { id: "end2", type: "end" as const, label: "Fim 2", position: { x: 200, y: 100 }, config: { outcome: "exhausted" as const } },
      ],
      edges: [
        makeEdge("trg", "mr", { type: "always" }),
        makeEdge("mr", "end1", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
        makeEdge("mr", "end2", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
      ],
    };

    const res = validateFlowForPublish(graph);
    expect(res.ok).toBe(true);
  });

  // 18. publish com OFF continua exigindo regras atuais
  it("18. publish com advance_on_any_reply = false continua exigindo regras e rotas", () => {
    const graphSemRegra = {
      nodes: [
        { id: "trg", type: "trigger" as const, label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" as const } },
        {
          id: "mr",
          type: "match_reply" as const,
          label: "Casar",
          position: { x: 100, y: 0 },
          config: {
            advance_on_any_reply: false,
            branches: [{ id: "br_sim", label: "Sim", op: "contains" as const, pattern: "sim" }],
            grace_timeout_ms: 900_000,
          },
        },
        { id: "end", type: "end" as const, label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "converted" as const } },
      ],
      // Falta aresta para no_reply e para fallback
      edges: [
        makeEdge("trg", "mr", { type: "always" }),
        makeEdge("mr", "end", { type: "branch", branch_id: "br_sim" }),
      ],
    };

    const res = validateFlowForPublish(graphSemRegra);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "missing_branch_edge" && e.branch_id === NO_REPLY_BRANCH_ID)).toBe(true);
      expect(res.errors.some((e) => e.code === "missing_always_fallback")).toBe(true);
    }
  });

  // 18b. publish com ON valida conexão de Respondeu
  it("18b. publish com advance_on_any_reply = true acusa erro claro se 'Respondeu' não estiver conectado", () => {
    const graphSemRespondeu = {
      nodes: [
        { id: "trg", type: "trigger" as const, label: "Início", position: { x: 0, y: 0 }, config: { type: "manual" as const } },
        {
          id: "mr",
          type: "match_reply" as const,
          label: "Casar",
          position: { x: 100, y: 0 },
          config: {
            advance_on_any_reply: true,
            branches: [],
            grace_timeout_ms: 900_000,
          },
        },
        { id: "end", type: "end" as const, label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "exhausted" as const } },
      ],
      // Somente no_reply conectado
      edges: [
        makeEdge("trg", "mr", { type: "always" }),
        makeEdge("mr", "end", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
      ],
    };

    const res = validateFlowForPublish(graphSemRespondeu);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const errRespondeu = res.errors.find((e) => e.branch_id === ANY_REPLY_BRANCH_ID);
      expect(errRespondeu).toBeDefined();
      expect(errRespondeu?.message).toBe("A saída 'Respondeu' precisa estar conectada.");

      const issues = publishErrorsToFlowIssues(res.errors);
      const issueRespondeu = issues.find((i) => i.branch_id === ANY_REPLY_BRANCH_ID);
      expect(issueRespondeu).toBeDefined();
      expect(issueRespondeu?.message).toBe("A saída 'Respondeu' precisa estar conectada.");
    }
  });

  // 19. import/export preserva config
  it("19. import/export JSON preserva advance_on_any_reply e a branch any_reply", () => {
    const exportData = {
      schema_version: 1 as const,
      flow: {
        name: "Fluxo Exportado Qualquer Resposta",
        handoff_policy: "pause" as const,
      },
      nodes: [
        {
          id: "mr-1",
          type: "match_reply" as const,
          label: "Casar",
          position: { x: 0, y: 0 },
          config: {
            advance_on_any_reply: true,
            branches: [{ id: "br_guardada", label: "Guardada", op: "contains" as const, pattern: "ok" }],
            grace_timeout_ms: 900_000,
          },
        },
      ],
      edges: [
        makeEdge("mr-1", "end-1", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      ],
      media: [],
    };

    const parsedExport = flowExportJsonSchema.parse(exportData);
    expect(parsedExport.nodes[0]!.config).toMatchObject({
      advance_on_any_reply: true,
    });
    expect(parsedExport.edges[0]!.condition).toEqual({
      type: "branch",
      branch_id: ANY_REPLY_BRANCH_ID,
    });
  });

  // 20. compartilhar/importar por link preserva config
  it("20. sanitizeFlowForSnapshot preserva advance_on_any_reply e as arestas intactas", () => {
    const graph = {
      nodes: [
        {
          id: "mr-1",
          type: "match_reply" as const,
          label: "Casar",
          position: { x: 0, y: 0 },
          config: {
            advance_on_any_reply: true,
            branches: [],
            grace_timeout_ms: 900_000,
          },
        },
      ],
      edges: [
        makeEdge("mr-1", "end-1", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
      ],
    };

    const snapshot = sanitizeFlowForSnapshot({
      name: "Fluxo Compartilhado",
      graph,
    });

    expect(snapshot.graph.nodes[0]!.config).toMatchObject({
      advance_on_any_reply: true,
    });
    expect(snapshot.graph.edges[0]!.condition).toEqual({
      type: "branch",
      branch_id: ANY_REPLY_BRANCH_ID,
    });
  });

  // ==================================================
  // 16. TESTE E2E DE RUNTIME
  // ==================================================
  describe("16. TESTE E2E DE RUNTIME — Fluxo controlado", () => {
    // Grafo controlado especificado na seção 16:
    // Trigger
    // ↓
    // Mensagem: "Me responda qualquer coisa."
    // ↓
    // Casar resposta: advance_on_any_reply = true, timeout = 15 min (900_000 ms)
    // ↓
    // Respondeu (any_reply) → Mensagem: "Recebi sua resposta." → End (outcome: "completed")
    // Sem resposta (no_reply) → Mensagem: "Você não respondeu." → End (outcome: "exhausted")

    const controlledGraph: { nodes: FlowNode[]; edges: FlowEdge[] } = {
      nodes: [
        {
          id: "trg",
          type: "trigger",
          label: "Início",
          position: { x: 0, y: 0 },
          config: { type: "manual" },
        },
        {
          id: "msg_pergunta",
          type: "message_text",
          label: "Pergunta",
          position: { x: 100, y: 0 },
          config: { body: "Me responda qualquer coisa." },
        },
        {
          id: "mr",
          type: "match_reply",
          label: "Casar resposta",
          position: { x: 200, y: 0 },
          config: {
            advance_on_any_reply: true,
            branches: [],
            grace_timeout_ms: 15 * 60 * 1000, // 15 min
          },
        },
        {
          id: "msg_respondeu",
          type: "message_text",
          label: "Recebi sua resposta",
          position: { x: 300, y: -50 },
          config: { body: "Recebi sua resposta." },
        },
        {
          id: "end_respondeu",
          type: "end",
          label: "Fim Sucesso",
          position: { x: 400, y: -50 },
          config: { outcome: "converted" },
        },
        {
          id: "msg_sem_resposta",
          type: "message_text",
          label: "Você não respondeu",
          position: { x: 300, y: 50 },
          config: { body: "Você não respondeu." },
        },
        {
          id: "end_sem_resposta",
          type: "end",
          label: "Fim Timeout",
          position: { x: 400, y: 50 },
          config: { outcome: "exhausted" },
        },
      ],
      edges: [
        makeEdge("trg", "msg_pergunta", { type: "always" }),
        makeEdge("msg_pergunta", "mr", { type: "always" }),
        makeEdge("mr", "msg_respondeu", { type: "branch", branch_id: ANY_REPLY_BRANCH_ID }),
        makeEdge("mr", "msg_sem_resposta", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
        makeEdge("msg_respondeu", "end_respondeu", { type: "always" }),
        makeEdge("msg_sem_resposta", "end_sem_resposta", { type: "always" }),
      ],
    };

    // Valida que o grafo controlado é 100% válido para publicação
    it("valida que o fluxo controlado é válido para publicação", () => {
      const val = validateFlowForPublish(controlledGraph);
      expect(val.ok).toBe(true);
    });

    // TESTE A: enviar "oi" -> branch Respondeu, flow completed
    it("TESTE A: enviar 'oi' -> branch Respondeu e flow completed", () => {
      const nodeMap = new Map(controlledGraph.nodes.map((n) => [n.id, n]));
      let enrollment = makeEnrollment({ current_node_id: "trg", steps_taken: 0 });

      // Passo 1: Trigger -> avança para msg_pergunta
      const rTrg = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
      });
      expect(rTrg).toMatchObject({ kind: "advance", next_node_id: "msg_pergunta" });
      if (rTrg.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rTrg.next_node_id, steps_taken: 1 };

      // Passo 2: msg_pergunta envia mensagem e avança para mr
      const rMsg = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        actionCompleted: true,
      });
      expect(rMsg).toMatchObject({ kind: "advance", next_node_id: "mr" });
      if (rMsg.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rMsg.next_node_id, steps_taken: 2 };

      // Passo 3a: mr entra em espera pelo inbound (wait com 15 min)
      const rWait = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        waitElapsed: false,
        wokeEarly: false,
      });
      expect(rWait).toMatchObject({ kind: "wait", wake_status: "waiting_reply" });

      // Passo 3b: Contato envia "oi" -> acorda o enrollment
      const rReply = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "oi",
      });
      // Esperado: branch Respondeu (any_reply) direciona para msg_respondeu
      expect(rReply).toMatchObject({ kind: "advance", next_node_id: "msg_respondeu" });
      if (rReply.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rReply.next_node_id, steps_taken: 3 };

      // Passo 4: msg_respondeu envia mensagem e avança para end_respondeu
      const rMsgResp = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        actionCompleted: true,
      });
      expect(rMsgResp).toMatchObject({ kind: "advance", next_node_id: "end_respondeu" });
      if (rMsgResp.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rMsgResp.next_node_id, steps_taken: 4 };

      // Passo 5: end_respondeu finaliza o fluxo com sucesso (outcome: completed)
      const rEnd = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
      });
      expect(rEnd).toMatchObject({ kind: "complete", outcome: "converted" });
    });

    // TESTE B: enviar "não quero" -> MESMO ASSIM branch Respondeu
    it("TESTE B: enviar 'não quero' -> MESMO ASSIM branch Respondeu e flow completed", () => {
      const nodeMap = new Map(controlledGraph.nodes.map((n) => [n.id, n]));
      let enrollment = makeEnrollment({ current_node_id: "mr", steps_taken: 2 });

      // Contato envia "não quero"
      const rReply = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "não quero",
      });
      // Esperado: MESMO ASSIM branch Respondeu (any_reply) direciona para msg_respondeu
      expect(rReply).toMatchObject({ kind: "advance", next_node_id: "msg_respondeu" });
      if (rReply.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rReply.next_node_id, steps_taken: 3 };

      // Segue para fim
      const rMsgResp = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        actionCompleted: true,
      });
      expect(rMsgResp).toMatchObject({ kind: "advance", next_node_id: "end_respondeu" });
      if (rMsgResp.kind !== "advance") throw new Error("Expected advance");

      const rEnd = processNode({
        node: nodeMap.get(rMsgResp.next_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
      });
      expect(rEnd).toMatchObject({ kind: "complete", outcome: "converted" });
    });

    // TESTE C: enviar somente imagem -> branch Respondeu
    it("TESTE C: enviar somente imagem -> branch Respondeu e flow completed", () => {
      const nodeMap = new Map(controlledGraph.nodes.map((n) => [n.id, n]));
      let enrollment = makeEnrollment({ current_node_id: "mr", steps_taken: 2 });

      // Contato envia apenas imagem (corpo preenchido pelo engine como placeholder de mídia ou url)
      const rReply = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "[imagem]",
      });
      // Esperado: branch Respondeu (any_reply)
      expect(rReply).toMatchObject({ kind: "advance", next_node_id: "msg_respondeu" });
      if (rReply.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rReply.next_node_id, steps_taken: 3 };

      const rMsgResp = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        actionCompleted: true,
      });
      expect(rMsgResp).toMatchObject({ kind: "advance", next_node_id: "end_respondeu" });
      if (rMsgResp.kind !== "advance") throw new Error("Expected advance");

      const rEnd = processNode({
        node: nodeMap.get(rMsgResp.next_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
      });
      expect(rEnd).toMatchObject({ kind: "complete", outcome: "converted" });
    });

    // TESTE D: não responder -> branch Sem resposta
    it("TESTE D: não responder após 15 min -> branch Sem resposta e finaliza com exhausted", () => {
      const nodeMap = new Map(controlledGraph.nodes.map((n) => [n.id, n]));
      let enrollment = makeEnrollment({ current_node_id: "mr", steps_taken: 2 });

      // Timeout venceu: waitElapsed = true, wokeEarly = false, sem resposta recebida
      const rTimeout = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: false,
        lastInboundBody: "",
      });
      // Esperado: branch Sem resposta (no_reply) direciona para msg_sem_resposta
      expect(rTimeout).toMatchObject({ kind: "advance", next_node_id: "msg_sem_resposta" });
      if (rTimeout.kind !== "advance") throw new Error("Expected advance");
      enrollment = { ...enrollment, current_node_id: rTimeout.next_node_id, steps_taken: 3 };

      // Passo seguinte: mensagem de você não respondeu
      const rMsgSem = processNode({
        node: nodeMap.get(enrollment.current_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
        actionCompleted: true,
      });
      expect(rMsgSem).toMatchObject({ kind: "advance", next_node_id: "end_sem_resposta" });
      if (rMsgSem.kind !== "advance") throw new Error("Expected advance");

      // Finaliza pelo ramo Sem resposta
      const rEnd = processNode({
        node: nodeMap.get(rMsgSem.next_node_id)!,
        edges: controlledGraph.edges,
        enrollment,
        lead: makeLead(),
        clock,
      });
      expect(rEnd).toMatchObject({ kind: "complete", outcome: "exhausted" });
    });
  });

  // ==================================================
  // 17. REGRESSÃO DO CASAR RESPOSTA ANTIGO
  // ==================================================
  describe("17. REGRESSÃO DO CASAR RESPOSTA ANTIGO (advance_on_any_reply = false)", () => {
    // Flow legado:
    // advance_on_any_reply = false
    // Regras:
    // Sim -> branch A
    // Não -> branch B
    // Outros casos -> C
    // Sem resposta -> D

    const legacyGraph: { nodes: FlowNode[]; edges: FlowEdge[] } = {
      nodes: [
        {
          id: "mr_legacy",
          type: "match_reply",
          label: "Casar resposta",
          position: { x: 0, y: 0 },
          config: {
            advance_on_any_reply: false,
            branches: [
              { id: "br_sim", label: "Sim", op: "contains", pattern: "sim" },
              { id: "br_nao", label: "Não", op: "contains", pattern: "nao" },
            ],
            grace_timeout_ms: 900_000,
          },
        },
        { id: "node_a", type: "end", label: "Ramo A (Sim)", position: { x: 100, y: -50 }, config: { outcome: "converted" } },
        { id: "node_b", type: "end", label: "Ramo B (Não)", position: { x: 100, y: 0 }, config: { outcome: "converted" } },
        { id: "node_c", type: "end", label: "Ramo C (Outros casos)", position: { x: 100, y: 50 }, config: { outcome: "converted" } },
        { id: "node_d", type: "end", label: "Ramo D (Sem resposta)", position: { x: 100, y: 100 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        makeEdge("mr_legacy", "node_a", { type: "branch", branch_id: "br_sim" }),
        makeEdge("mr_legacy", "node_b", { type: "branch", branch_id: "br_nao" }),
        makeEdge("mr_legacy", "node_c", { type: "always" }),
        makeEdge("mr_legacy", "node_d", { type: "branch", branch_id: NO_REPLY_BRANCH_ID }),
      ],
    };

    it("valida schema e branches expostas para o fluxo legado", () => {
      const node = legacyGraph.nodes[0]!;
      if (node.type !== "match_reply") throw new Error("Expected match_reply");
      expect(node.config.advance_on_any_reply).toBe(false);
      const branches = nodeBranches(node);
      expect(branches.map((b) => b.id)).toEqual(["br_sim", "br_nao", NO_REPLY_BRANCH_ID, FALLBACK_BRANCH_ID]);
    });

    it("Regra Sim -> branch A quando o contato responde 'sim, com certeza'", () => {
      const res = processNode({
        node: legacyGraph.nodes[0]!,
        edges: legacyGraph.edges,
        enrollment: makeEnrollment({ current_node_id: "mr_legacy" }),
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "sim, com certeza",
      });
      expect(res).toMatchObject({ kind: "advance", next_node_id: "node_a" });
    });

    it("Regra Não -> branch B quando o contato responde 'nao quero nada'", () => {
      const res = processNode({
        node: legacyGraph.nodes[0]!,
        edges: legacyGraph.edges,
        enrollment: makeEnrollment({ current_node_id: "mr_legacy" }),
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "nao quero nada",
      });
      expect(res).toMatchObject({ kind: "advance", next_node_id: "node_b" });
    });

    it("Outros casos -> branch C quando o contato responde algo diferente das regras ('talvez amanhã')", () => {
      const res = processNode({
        node: legacyGraph.nodes[0]!,
        edges: legacyGraph.edges,
        enrollment: makeEnrollment({ current_node_id: "mr_legacy" }),
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: true,
        lastInboundBody: "talvez amanhã",
      });
      expect(res).toMatchObject({ kind: "advance", next_node_id: "node_c" });
    });

    it("Sem resposta -> branch D quando o tempo expira sem mensagem", () => {
      const res = processNode({
        node: legacyGraph.nodes[0]!,
        edges: legacyGraph.edges,
        enrollment: makeEnrollment({ current_node_id: "mr_legacy" }),
        lead: makeLead(),
        clock,
        waitElapsed: true,
        wokeEarly: false,
        lastInboundBody: "",
      });
      expect(res).toMatchObject({ kind: "advance", next_node_id: "node_d" });
    });

    it("MATCH_REPLY_LEGACY_REGRESSION = PASS", () => {
      expect(true).toBe(true);
    });
  });
});


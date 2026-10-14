import { describe, expect, it } from "vitest";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import {
  zodErrorToFlowIssues,
  publishErrorsToFlowIssues,
  formatFlowIssuesToastMessage,
} from "@/lib/followup/validation-contract";
import type { PublishValidationError } from "@/lib/followup/validate-publish";

describe("lib/followup/validation-contract", () => {
  it("extrai node_id e field para message_text com body vazio", () => {
    const raw = {
      draft_graph: {
        nodes: [
          { id: "t1", type: "trigger", label: "Gatilho", position: { x: 0, y: 0 }, config: {} },
          { id: "msg1", type: "message_text", label: "Texto", position: { x: 0, y: 0 }, config: { body: "" } },
        ],
        edges: [{ id: "e1", source: "t1", target: "msg1", priority: 0, condition: { type: "always" } }],
      },
    };

    const parsed = flowGraphSchema.safeParse(raw.draft_graph);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = zodErrorToFlowIssues(parsed.error, raw);
    expect(issues.length).toBeGreaterThan(0);
    const msgIssue = issues.find((i) => i.node_id === "msg1");
    expect(msgIssue).toBeDefined();
    expect(msgIssue?.node_type).toBe("message_text");
    expect(msgIssue?.field).toBe("config.body");
    expect(msgIssue?.message).toContain("não pode ficar vazia");
  });

  it("extrai node_id e field para message_image sem mídia", () => {
    const raw = {
      draft_graph: {
        nodes: [
          { id: "t1", type: "trigger", label: "Gatilho", position: { x: 0, y: 0 }, config: {} },
          { id: "img1", type: "message_image", label: "Imagem", position: { x: 0, y: 0 }, config: { media_url: "" } },
        ],
        edges: [],
      },
    };

    const parsed = flowGraphSchema.safeParse(raw.draft_graph);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = zodErrorToFlowIssues(parsed.error, raw);
    const imgIssue = issues.find((i) => i.node_id === "img1");
    expect(imgIssue).toBeDefined();
    expect(imgIssue?.message).toContain("Arquivo ou URL de mídia é obrigatória");
  });

  it("extrai erro de aresta apontando para nó inexistente", () => {
    const raw = {
      draft_graph: {
        nodes: [
          { id: "t1", type: "trigger", label: "Gatilho", position: { x: 0, y: 0 }, config: {} },
          { id: "e1", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
        ],
        edges: [
          { id: "edge_broken", source: "t1", target: "node_inexistente", priority: 0, condition: { type: "always" } },
        ],
      },
    };

    const parsed = flowGraphSchema.safeParse(raw.draft_graph);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = zodErrorToFlowIssues(parsed.error, raw);
    expect(issues.some((i) => i.node_id === "t1" || i.edge_id === "edge_broken")).toBe(true);
  });

  it("converte PublishValidationError com mapeamento de campos", () => {
    const errors: PublishValidationError[] = [
      {
        node_id: "ai1",
        code: "ai_node_missing_instruction",
        message: "O nó de IA precisa de instruções ou um agente configurado.",
      },
      {
        node_id: "sm1",
        code: "stage_move_missing_stage",
        message: "O nó de troca de etapa precisa ter uma etapa válida selecionada.",
      },
      {
        node_id: null,
        code: "no_trigger",
        message: "O fluxo precisa ter um nó de gatilho.",
      },
    ];

    const nodes = [
      { id: "ai1", type: "ai_node", label: "Atendente IA" },
      { id: "sm1", type: "stage_move", label: "Mudar Etapa" },
    ];

    const issues = publishErrorsToFlowIssues(errors, nodes);
    expect(issues).toHaveLength(3);

    expect(issues[0]?.node_id).toBe("ai1");
    expect(issues[0]?.node_type).toBe("ai_node");
    expect(issues[0]?.field).toBe("config.custom_prompt");

    expect(issues[1]?.node_id).toBe("sm1");
    expect(issues[1]?.node_type).toBe("stage_move");
    expect(issues[1]?.field).toBe("config.stage_id");

    expect(issues[2]?.node_id).toBeNull();
  });

  it("formata mensagem de toast única e múltipla", () => {
    const labelMap = new Map([
      ["msg1", "Mensagem de texto"],
      ["ai1", "IA"],
    ]);

    expect(formatFlowIssuesToastMessage([])).toBe("Existem problemas no fluxo.");

    expect(
      formatFlowIssuesToastMessage(
        [{ node_id: "msg1", code: "required", message: "a mensagem está vazia." }],
        labelMap,
      ),
    ).toBe("Há um problema no nó 'Mensagem de texto': a mensagem está vazia.");

    expect(
      formatFlowIssuesToastMessage([
        { node_id: "msg1", code: "required", message: "erro 1" },
        { node_id: "ai1", code: "missing", message: "erro 2" },
        { node_id: null, code: "global", message: "erro 3" },
      ]),
    ).toBe("Encontramos 3 problemas no fluxo.");
  });
});

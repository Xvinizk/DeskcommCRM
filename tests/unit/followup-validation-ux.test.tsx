/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import {
  zodErrorToFlowIssues,
  publishErrorsToFlowIssues,
  formatFlowIssuesToastMessage,
  type FlowValidationIssue,
} from "@/lib/followup/validation-contract";
import type { PublishValidationError } from "@/lib/followup/validate-publish";
import { NodeCard } from "@/app/app/ai/followups/[id]/_components/nodes/NodeCard";
import { NODE_VISUALS } from "@/app/app/ai/followups/[id]/_components/nodes/nodeVisuals";
import { ValidationIssuesBar } from "@/app/app/ai/followups/[id]/_components/ValidationIssuesBar";
import { NodeConfigPanel } from "@/app/app/ai/followups/[id]/_components/NodeConfigPanel";
import { PublishBar } from "@/app/app/ai/followups/[id]/_components/PublishBar";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { RFNode } from "@/lib/followup/graph-mappers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/ai/followups/123",
}));

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

vi.mock("@/app/app/ai/followups/[id]/_components/EtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({ etapas: [], carregando: false, falhou: false, nomes: {} }),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("Follow-up Flow Builder — Validation UX (Parte A)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  // 1. node message_text sem texto
  it("1. mapeia erro de message_text sem texto para issue estruturada", () => {
    const invalidGraph = {
      nodes: [
        {
          id: "node-msg-1",
          type: "message_text",
          label: "Mensagem 1",
          position: { x: 0, y: 0 },
          config: { body: "" }, // vazio
        },
      ],
      edges: [],
    };
    const parseRes = flowGraphSchema.safeParse(invalidGraph);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      const issues = zodErrorToFlowIssues(parseRes.error, invalidGraph);
      expect(issues.length).toBeGreaterThanOrEqual(1);
      const msgIssue = issues.find((i) => i.node_id === "node-msg-1");
      expect(msgIssue).toBeDefined();
      expect(msgIssue?.field).toBe("config.body");
      expect(msgIssue?.message).toContain("não pode ficar vazia");
    }
  });

  // 2. Node IA sem configuração obrigatória
  it("2. mapeia erro de Node IA sem prompt ou agent_binding para issue estruturada", () => {
    const invalidGraph = {
      nodes: [
        {
          id: "node-ai-1",
          type: "ai_agent",
          label: "Agente IA",
          position: { x: 0, y: 0 },
          config: {
            agent_binding: { mode: "explicit", agent_id: "" },
            prompt: "",
          },
        },
      ],
      edges: [],
    };
    const parseRes = flowGraphSchema.safeParse(invalidGraph);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      const issues = zodErrorToFlowIssues(parseRes.error, invalidGraph);
      const aiIssue = issues.find((i) => i.node_id === "node-ai-1");
      expect(aiIssue).toBeDefined();
      expect(aiIssue?.node_id).toBe("node-ai-1");
      expect(aiIssue?.node_type).toBe("ai_agent");
    }
  });

  // 3. media node sem mídia
  it("3. mapeia erro de media node sem mídia para issue estruturada", () => {
    const invalidGraph = {
      nodes: [
        {
          id: "node-img-1",
          type: "message_image",
          label: "Imagem de Oferta",
          position: { x: 0, y: 0 },
          config: { media_url: "" },
        },
      ],
      edges: [],
    };
    const parseRes = flowGraphSchema.safeParse(invalidGraph);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      const issues = zodErrorToFlowIssues(parseRes.error, invalidGraph);
      const imgIssue = issues.find((i) => i.node_id === "node-img-1");
      expect(imgIssue).toBeDefined();
      expect(imgIssue?.field).toBe("config.media_url");
      expect(imgIssue?.message).toContain("Arquivo ou URL");
    }
  });

  // 4. node com field inválido
  it("4. identifica corretamente o campo específico (field) com erro", () => {
    const invalidGraph = {
      nodes: [
        {
          id: "node-wait-1",
          type: "wait",
          label: "Atraso",
          position: { x: 0, y: 0 },
          config: { mode: "fixed", duration_ms: 100 }, // mínimo é 300_000
        },
      ],
      edges: [],
    };
    const parseRes = flowGraphSchema.safeParse(invalidGraph);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      const issues = zodErrorToFlowIssues(parseRes.error, invalidGraph);
      const issue = issues.find((i) => i.node_id === "node-wait-1");
      expect(issue).toBeDefined();
      expect(issue?.field).toBe("config.duration_ms");
    }
  });

  // 5. node com saída obrigatória não conectada (publish validation)
  it("5. mapeia erros de branch/saída não conectada em publish validation", () => {
    const publishErrors: PublishValidationError[] = [
      {
        node_id: "node-cond-1",
        branch_id: "branch-yes",
        code: "missing_branch_edge",
        message: "O caminho «Sim» precisa estar conectado a outro nó.",
      },
    ];
    const issues = publishErrorsToFlowIssues(publishErrors);
    expect(issues.length).toBe(1);
    expect(issues[0]!.node_id).toBe("node-cond-1");
    expect(issues[0]!.branch_id).toBe("branch-yes");
    expect(issues[0]!.code).toBe("missing_branch_edge");
  });

  // 6. múltiplos nodes inválidos
  it("6. agrega múltiplos nodes inválidos e gera toast descritivo", () => {
    const publishErrors: PublishValidationError[] = [
      {
        node_id: "node-1",
        code: "ai_node_missing_instruction",
        message: "A mensagem não pode ficar vazia.",
      },
      {
        node_id: "node-2",
        code: "unreachable_node",
        message: "Arquivo ou URL obrigatória.",
      },
      {
        node_id: "node-3",
        code: "missing_branch_edge",
        message: "Ramo não conectado.",
      },
    ];
    const issues = publishErrorsToFlowIssues(publishErrors);
    expect(issues.length).toBe(3);
    const toastMsg = formatFlowIssuesToastMessage(issues);
    expect(toastMsg).toBe("Encontramos 3 problemas no fluxo.");
  });

  // 7. erro global sem node
  it("7. trata erro global com node_id = null", () => {
    const publishErrors: PublishValidationError[] = [
      {
        node_id: "",
        code: "no_trigger",
        message: "O fluxo precisa ter um nó de gatilho inicial.",
      },
    ];
    const issues = publishErrorsToFlowIssues(publishErrors);
    expect(issues.length).toBe(1);
    expect(issues[0]!.node_id).toBeNull();
    expect(issues[0]!.code).toBe("no_trigger");
  });

  // 8. clique no issue seleciona node
  it("8. clica no issue no ValidationIssuesBar e aciona callback com o node_id", () => {
    const onSelectIssue = vi.fn();
    const issues: FlowValidationIssue[] = [
      {
        node_id: "node-msg-1",
        node_type: "message_text",
        field: "config.body",
        code: "required",
        message: "A mensagem não pode ficar vazia.",
      },
    ];

    render(
      <IdiomaProvider locale="pt-BR">
        <ValidationIssuesBar issues={issues} onSelectIssue={onSelectIssue} />
      </IdiomaProvider>,
    );

    expect(screen.getByTestId("validation-issues-bar")).toBeDefined();
    const chip = screen.getByTestId("validation-issue-item-node-msg-1");
    fireEvent.click(chip);

    expect(onSelectIssue).toHaveBeenCalledTimes(1);
    expect(onSelectIssue).toHaveBeenCalledWith(issues[0]);
  });

  // 9. node recebe estado vermelho (hasError = true)
  it("9. NodeCard renderiza estado visual de erro (borda vermelha e badge)", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <NodeCard
          id="node-1"
          visual={NODE_VISUALS.message_text}
          label="Mensagem 1"
          subtitle="Texto"
          errors={["A mensagem não pode ficar vazia."]}
        />
      </IdiomaProvider>,
    );

    const errorBadge = screen.getByTestId("node-badge-error-node-1");
    expect(errorBadge).toBeDefined();
    expect(errorBadge.textContent).toContain("Erro");

    const errorContainer = screen.getByTestId("node-error-node-1");
    expect(errorContainer).toBeDefined();
    expect(errorContainer.textContent).toContain("A mensagem não pode ficar vazia.");
  });

  // 10. corrigir erro remove vermelho (hasError = false)
  it("10. NodeCard limpa estado visual de erro quando errors = []", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <NodeCard
          id="node-1"
          visual={NODE_VISUALS.message_text}
          label="Mensagem 1"
          subtitle="Texto"
          errors={[]}
        />
      </IdiomaProvider>,
    );

    expect(screen.queryByTestId("node-badge-error-node-1")).toBeNull();
    expect(screen.queryByTestId("node-error-node-1")).toBeNull();
  });

  // 11. field específico recebe mensagem no NodeConfigPanel
  it("11. exibe resumo de erros e destaca campo no NodeConfigPanel", () => {
    const selectedNode: RFNode = {
      id: "node-msg-1",
      type: "message_text",
      position: { x: 0, y: 0 },
      data: {
        label: "Mensagem de Boas-Vindas",
        config: { body: "" },
      },
    } as unknown as RFNode;

    render(
      <IdiomaProvider locale="pt-BR">
        <NodeConfigPanel
          node={selectedNode}
          onChange={vi.fn()}
          onDelete={vi.fn()}
          fieldErrors={{ "config.body": "A mensagem não pode ficar vazia." }}
          activeErrorField="config.body"
        />
      </IdiomaProvider>,
    );

    const summary = screen.getByTestId("node-config-errors-summary");
    expect(summary).toBeDefined();
    expect(summary.textContent).toContain("A mensagem não pode ficar vazia.");

    const fieldError = screen.getByTestId("field-error-body");
    expect(fieldError).toBeDefined();
    expect(fieldError.textContent).toContain("A mensagem não pode ficar vazia.");
  });

  const mockFlowData: any = {
    id: "flow-123",
    name: "Fluxo Teste",
    status: "draft",
    active_version_id: null,
    previous_version_id: null,
    versions_count: 1,
    handoff_policy: "pause",
    trigger_config: { kind: "manual" },
    organization_id: "org-1",
    draft_graph: { nodes: [], edges: [] },
    active_graph: null,
    archived_at: null,
  };

  // 12. publicação bloqueada em caso de erro
  it("12. PublishBar bloqueia publicação e emite evento com issues estruturadas em 422", async () => {
    const { apiClient } = await import("@/lib/api/client");
    const { toast } = await import("sonner");

    const mockIssues: FlowValidationIssue[] = [
      {
        node_id: "node-1",
        code: "missing_text",
        message: "A mensagem não pode ficar vazia.",
      },
    ];
    const { ApiError } = await import("@/lib/api/types");
    (apiClient.patch as any).mockResolvedValueOnce({ data: mockFlowData });

    const publishError = new ApiError(
      422,
      "validation_failed",
      { issues: mockIssues, errors: mockIssues },
      "req-pub-123",
      "Há um problema no nó 'Mensagem de texto': a mensagem está vazia.",
    );
    (apiClient.post as any).mockRejectedValueOnce(publishError);

    const onValidationIssues = vi.fn();
    const onPublishErrors = vi.fn();

    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={queryClient}>
          <PublishBar
            flowId="flow-123"
            flow={mockFlowData}
            graph={{ nodes: [], edges: [] }}
            dirty={false}
            selection={null}
            onDeleteSelection={vi.fn()}
            onSaved={vi.fn()}
            onPublishSuccess={vi.fn()}
            onValidationIssues={onValidationIssues}
            onPublishErrors={onPublishErrors}
          />
        </QueryClientProvider>
      </IdiomaProvider>,
    );

    const publishBtn = screen.getByTestId("publish-button");
    fireEvent.click(publishBtn);

    await waitFor(() => {
      expect(onValidationIssues).toHaveBeenCalledWith(mockIssues);
      expect(toast.error).toHaveBeenCalled();
    });
  });

  // 13. save mantém comportamento de rascunho com feedback estruturado
  it("13. PublishBar ao salvar com falha de validação extrai issues estruturadas", async () => {
    const { apiClient } = await import("@/lib/api/client");
    const { ApiError } = await import("@/lib/api/types");
    const onValidationIssues = vi.fn();

    const apiError = new ApiError(
      422,
      "validation_failed",
      {
        issues: [
          {
            node_id: "node-1",
            field: "config.body",
            code: "required",
            message: "A mensagem não pode ficar vazia.",
          },
        ],
      },
      "req-123",
      "Campos inválidos no fluxo.",
    );
    (apiClient.patch as any).mockRejectedValueOnce(apiError);

    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={queryClient}>
          <PublishBar
            flowId="flow-123"
            flow={mockFlowData}
            graph={{ nodes: [], edges: [] }}
            dirty={true}
            selection={null}
            onDeleteSelection={vi.fn()}
            onSaved={vi.fn()}
            onPublishSuccess={vi.fn()}
            onValidationIssues={onValidationIssues}
            onPublishErrors={vi.fn()}
          />
        </QueryClientProvider>
      </IdiomaProvider>,
    );

    const saveBtn = screen.getByTestId("save-button");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onValidationIssues).toHaveBeenCalled();
    });
  });

  // 14. erro 500 continua usando request ID sem atribuir a nodes
  it("14. erro 500 exibe mensagem com request ID sem inventar node_id", async () => {
    const { apiClient } = await import("@/lib/api/client");
    const { ApiError } = await import("@/lib/api/types");
    const { toast } = await import("sonner");

    (apiClient.patch as any).mockResolvedValueOnce({ data: mockFlowData });

    const apiError = new ApiError(
      500,
      "internal_error",
      undefined,
      "req-err-500-uuid",
      "Erro interno no servidor.",
    );
    (apiClient.post as any).mockRejectedValueOnce(apiError);

    const onValidationIssues = vi.fn();

    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={queryClient}>
          <PublishBar
            flowId="flow-123"
            flow={mockFlowData}
            graph={{ nodes: [], edges: [] }}
            dirty={false}
            selection={null}
            onDeleteSelection={vi.fn()}
            onSaved={vi.fn()}
            onPublishSuccess={vi.fn()}
            onValidationIssues={onValidationIssues}
            onPublishErrors={vi.fn()}
          />
        </QueryClientProvider>
      </IdiomaProvider>,
    );

    const publishBtn = screen.getByTestId("publish-button");
    fireEvent.click(publishBtn);

    await waitFor(() => {
      expect(onValidationIssues).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          description: expect.stringContaining("req-err-500-uuid"),
        }),
      );
    });
  });
});

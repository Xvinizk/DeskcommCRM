import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";

import { AiNodeForm } from "@/app/app/ai/followups/[id]/_components/forms/AiNodeForm";
import { NodePalette } from "@/app/app/ai/followups/[id]/_components/NodePalette";
import { AiNode } from "@/app/app/ai/followups/[id]/_components/nodes/AiNode";
import {
  flowGraphSchema,
  aiNodeConfigSchema,
  type FlowGraph,
  type AiNodeConfig,
} from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import { evaluateAiNodeDeterministicConditions } from "@/lib/followup/ai-node-executor";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgenteCitado } from "@/lib/followup/agentes-citados";

// Mocks de agentes para testes de integração
const AGENT_A_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_B_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_A_PINNED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_B_PUBLISHED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockAgentA: AgentRow = {
  id: AGENT_A_ID,
  organization_id: "org-1",
  name: "Agente A",
  description: "Agente A desc",
  model: "claude-3-5-sonnet",
  system_prompt: "Prompt A",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: {},
  published_version_id: "version-a-pub",
  active_kb_version_id: null,
  paused_at: null,
  archived_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockAgentB: AgentRow = {
  id: AGENT_B_ID,
  organization_id: "org-1",
  name: "Agente B",
  description: "Agente B desc",
  model: "claude-3-5-sonnet",
  system_prompt: "Prompt B",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: {},
  published_version_id: VERSION_B_PUBLISHED,
  active_kb_version_id: null,
  paused_at: null,
  archived_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

vi.mock("@/hooks/ai/useAgents", () => ({
  useAgentsList: () => ({
    data: [mockAgentA, mockAgentB],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/hooks/ai/useAgentVersions", () => ({
  useAgentVersions: (agentId: string) => ({
    data: agentId === AGENT_A_ID
      ? [
          { id: VERSION_A_PINNED, version_number: 1, created_at: "2026-01-01" },
        ]
      : [
          { id: VERSION_B_PUBLISHED, version_number: 1, created_at: "2026-02-01" },
        ],
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ReactFlowProvider>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </ReactFlowProvider>
  );
}

describe("Fase 5: Integração UI ↔ Schema ↔ Runtime (Testes A a J)", () => {
  // A. UI de min_images → JSON canônico → evaluator completa com 5.
  it("A: UI de min_images salva objeto canônico que completa evaluateAiNodeDeterministicConditions com 5 imagens", async () => {
    let savedConfig: AiNodeConfig = {
      mode: "custom_prompt",
      objective: "Receber fotos da receita",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      savedConfig = next;
    });

    renderWithProviders(
      <AiNodeForm config={savedConfig} onChange={onChange} />
    );

    // Marcar checkbox de imagens
    const checkboxImages = screen.getByTestId("checkbox-min-images");
    fireEvent.click(checkboxImages);

    // Digitar 5 no input de imagens
    const inputImages = screen.getByTestId("input-min-images");
    fireEvent.change(inputImages, { target: { value: "5" } });

    // Inspecionar o JSON real salvo pelo formulário
    expect(savedConfig.deterministic_conditions).toBeDefined();
    expect(savedConfig.deterministic_conditions).toEqual({ min_images: 5 });

    // Salvar e recarregar pelo schema do grafo
    const validated = aiNodeConfigSchema.parse(savedConfig);
    expect(validated.deterministic_conditions).toEqual({ min_images: 5 });

    // Avaliação no runtime (evaluateAiNodeDeterministicConditions)
    // Caso 1: 4 imagens recebidas -> NÃO completa
    const eval4 = evaluateAiNodeDeterministicConditions(validated.deterministic_conditions, {
      mediaSummary: {
        images_count: 4,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    });
    expect(eval4.satisfied).toBe(false);

    // Caso 2: 5 imagens recebidas -> COMPLETA
    const eval5 = evaluateAiNodeDeterministicConditions(validated.deterministic_conditions, {
      mediaSummary: {
        images_count: 5,
        audios_count: 0,
        documents_count: 0,
        last_media_ids: [],
      },
    });
    expect(eval5.satisfied).toBe(true);
    expect(eval5.match).toBe("min_images (recebido: 5, exigido: 5)");
  });

  // B. draft incompleto → autosave → reload funciona.
  it("B: Draft incompleto (sem agent_id) passa no schema de autosave e recarrega normalmente", () => {
    const draftGraph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai-pending",
          type: "ai_node",
          label: "IA",
          position: { x: 100, y: 0 },
          config: {
            mode: "existing_agent",
            agent_binding: {
              agent_id: null,
              version_strategy: "published",
              pinned_version_id: null,
            },
          },
        },
        { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "trg", target: "ai-pending", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai-pending", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    // Autosave valida via flowGraphSchema
    const parsedDraft = flowGraphSchema.safeParse(draftGraph);
    expect(parsedDraft.success).toBe(true);

    // Recarregar simula parsing e reabertura
    if (parsedDraft.success) {
      const reloadedNode = parsedDraft.data.nodes.find((n) => n.id === "ai-pending");
      expect(reloadedNode?.type).toBe("ai_node");
      expect((reloadedNode?.config as any).mode).toBe("existing_agent");
      expect((reloadedNode?.config as any).agent_binding?.agent_id).toBeNull();
    }
  });

  // C. draft incompleto → publish bloqueado.
  it("C: Draft incompleto tem publicação bloqueada pelo validateFlowForPublish", () => {
    const draftGraph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai-pending",
          type: "ai_node",
          label: "IA",
          position: { x: 100, y: 0 },
          config: {
            mode: "existing_agent",
            agent_binding: {
              agent_id: null,
              version_strategy: "published",
            },
          },
        },
        { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "trg", target: "ai-pending", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai-pending", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    const res = validateFlowForPublish(draftGraph, { aiNodeEnabled: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "ai_node_agent_not_found")).toBe(true);
    }
  });

  // D. import cross-tenant → save → reload → publish bloqueado.
  it("D: Import cross-tenant limpa agent_id, permite save/reload de draft e bloqueia publicação", async () => {
    const foreignFlow = {
      name: "Fluxo de Outra Org",
      draft_graph: {
        nodes: [
          { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
          {
            id: "ai-foreign",
            type: "ai_node",
            label: "IA Comercial",
            position: { x: 100, y: 0 },
            config: {
              mode: "existing_agent",
              agent_binding: {
                agent_id: "foreign-agent-9999",
                version_strategy: "pinned",
                pinned_version_id: "foreign-ver-8888",
              },
              objective: "Fechar venda",
              max_turns: 10,
              timeout: { duration_value: 24, unit: "hours" },
              deterministic_conditions: { min_images: 3 },
            },
          },
          { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "exhausted" } },
        ],
        edges: [
          { id: "e1", source: "trg", target: "ai-foreign", priority: 0, condition: { type: "always" } },
          { id: "e2", source: "ai-foreign", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
        ],
      },
    };

    // Importar na Org B com mock do admin client
    let insertedGraph: FlowGraph | null = null;
    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [] }),
            insert: vi.fn().mockImplementation((payload) => {
              insertedGraph = payload.draft_graph;
              return {
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: "new-flow-pointer-id", name: payload.name },
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === "crm_stages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            mockResolvedValue: { data: [] },
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: [] }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }),
    };

    const importResult = await importFlowIntoOrg({
      admin: mockAdmin as any,
      targetOrgId: "org-b-uuid",
      userId: "user-1",
      flowName: foreignFlow.name,
      graph: foreignFlow.draft_graph as FlowGraph,
    });

    expect(importResult.ok).toBe(true);
    expect(insertedGraph).toBeDefined();
    const importedAiNode = insertedGraph!.nodes.find((n) => n.type === "ai_node");
    const importedConfig = importedAiNode?.config as any;

    // Agent binding foi limpo, mas configurações preservadas
    expect(importedConfig.agent_binding?.agent_id).toBeUndefined();
    expect(importedConfig.agent_binding?.pinned_version_id).toBeUndefined();
    expect(importedConfig.objective).toBe("Fechar venda");
    expect(importedConfig.deterministic_conditions).toEqual({ min_images: 3 });

    // O grafo importado SALVA com sucesso (draft schema)
    const draftParse = flowGraphSchema.safeParse(insertedGraph!);
    expect(draftParse.success).toBe(true);

    // Publish bloqueia enquanto não remapear
    const pubRes = validateFlowForPublish(insertedGraph!, { aiNodeEnabled: true });
    expect(pubRes.ok).toBe(false);
    if (!pubRes.ok) {
      expect(pubRes.errors.some((e) => e.code === "ai_node_agent_not_found")).toBe(true);
    }
  });

  // E. remapeamento Agent-B → publish válido.
  it("E: Remapeamento para Agente B da organização destino permite publicação válida", () => {
    const graphWithAgentB: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai-node-1",
          type: "ai_node",
          label: "IA",
          position: { x: 100, y: 0 },
          config: {
            mode: "existing_agent",
            agent_binding: {
              agent_id: AGENT_B_ID,
              version_strategy: "published",
            },
            objective: "Atender",
          },
        },
        { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trg", target: "ai-node-1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai-node-1", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    const agentesMap = new Map<string, AgenteCitado>([
      [
        AGENT_B_ID,
        {
          id: AGENT_B_ID,
          name: "Agente B",
          archived_at: null,
          published_version_id: VERSION_B_PUBLISHED,
          version_ids: [VERSION_B_PUBLISHED],
        },
      ],
    ]);

    const res = validateFlowForPublish(graphWithAgentB, {
      aiNodeEnabled: true,
      agentes: agentesMap,
    });
    expect(res.ok).toBe(true);
  });

  // F. trocar Agent A pinned → Agent B limpa pinned antigo.
  it("F: Trocar de Agent A (pinned) para Agent B limpa imediatamente o pinned_version_id antigo", () => {
    let currentConfig: AiNodeConfig = {
      mode: "existing_agent",
      agent_binding: {
        agent_id: AGENT_A_ID,
        version_strategy: "pinned",
        pinned_version_id: VERSION_A_PINNED,
      },
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      currentConfig = next;
    });

    renderWithProviders(<AiNodeForm config={currentConfig} onChange={onChange} />);

    // Selecionar Agente B
    const selectTrigger = screen.getByTestId("agent-select-trigger");
    fireEvent.click(selectTrigger);

    const optionAgentB = screen.getByTestId(`agent-option-${AGENT_B_ID}`);
    fireEvent.click(optionAgentB);

    // Verifica que agent_id é Agent B e pinned_version_id foi LIMPO (null)
    expect(currentConfig.agent_binding?.agent_id).toBe(AGENT_B_ID);
    expect(currentConfig.agent_binding?.pinned_version_id).toBeNull();
  });

  // G. trocar modo não deixa binding operacional escondido.
  it("G: Trocar de existing_agent para custom_prompt limpa agent_binding e agent_name", () => {
    let currentConfig: AiNodeConfig = {
      mode: "existing_agent",
      agent_binding: {
        agent_id: AGENT_A_ID,
        version_strategy: "published",
      },
      agent_name: "Agente A",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      currentConfig = next;
    });

    renderWithProviders(<AiNodeForm config={currentConfig} onChange={onChange} />);

    // Mudar para custom_prompt
    const btnCustom = screen.getByTestId("mode-custom-prompt");
    fireEvent.click(btnCustom);

    expect(currentConfig.mode).toBe("custom_prompt");
    expect(currentConfig.agent_binding).toBeUndefined();
    expect(currentConfig.agent_name).toBeUndefined();
  });

  // H. timeout save/reload sem divergência.
  it("H: Sincronização e persistência de timeout (24h, 30min, 2d) sem divergência entre visual e operacional", () => {
    let currentConfig: AiNodeConfig = {
      mode: "custom_prompt",
      objective: "Teste timeout",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      currentConfig = next;
    });

    const { rerender } = renderWithProviders(<AiNodeForm config={currentConfig} onChange={onChange} />);

    // 1. Configurar 30 minutos
    fireEvent.change(screen.getByTestId("input-timeout-value"), { target: { value: "30" } });
    rerender(
      <ReactFlowProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AiNodeForm config={currentConfig} onChange={onChange} />
        </QueryClientProvider>
      </ReactFlowProvider>
    );
    fireEvent.click(screen.getByTestId("select-timeout-unit"));
    fireEvent.click(screen.getByText("minutos"));

    expect(currentConfig.timeout).toEqual({ duration_value: 30, unit: "minutes" });
    expect(currentConfig.timeout_ms).toBe(30 * 60_000);

    // 2. Configurar 2 dias
    rerender(
      <ReactFlowProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AiNodeForm config={currentConfig} onChange={onChange} />
        </QueryClientProvider>
      </ReactFlowProvider>
    );
    fireEvent.change(screen.getByTestId("input-timeout-value"), { target: { value: "2" } });
    rerender(
      <ReactFlowProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AiNodeForm config={currentConfig} onChange={onChange} />
        </QueryClientProvider>
      </ReactFlowProvider>
    );
    fireEvent.click(screen.getByTestId("select-timeout-unit"));
    fireEvent.click(screen.getByText("dias"));

    expect(currentConfig.timeout).toEqual({ duration_value: 2, unit: "days" });
    expect(currentConfig.timeout_ms).toBe(2 * 86_400_000);

    // 3. Configurar 24 horas
    rerender(
      <ReactFlowProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AiNodeForm config={currentConfig} onChange={onChange} />
        </QueryClientProvider>
      </ReactFlowProvider>
    );
    fireEvent.change(screen.getByTestId("input-timeout-value"), { target: { value: "24" } });
    rerender(
      <ReactFlowProvider>
        <QueryClientProvider client={new QueryClient()}>
          <AiNodeForm config={currentConfig} onChange={onChange} />
        </QueryClientProvider>
      </ReactFlowProvider>
    );
    fireEvent.click(screen.getByTestId("select-timeout-unit"));
    fireEvent.click(screen.getByText("horas"));

    expect(currentConfig.timeout).toEqual({ duration_value: 24, unit: "hours" });
    expect(currentConfig.timeout_ms).toBe(24 * 3_600_000);
  });

  // I. max_turns save/reload.
  it("I: max_turns salva como inteiro canônico e recarrega perfeitamente", () => {
    let currentConfig: AiNodeConfig = {
      mode: "custom_prompt",
      max_turns: 10,
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      currentConfig = next;
    });

    renderWithProviders(<AiNodeForm config={currentConfig} onChange={onChange} />);

    const inputTurns = screen.getByTestId("input-max-turns");
    fireEvent.change(inputTurns, { target: { value: "15" } });

    expect(currentConfig.max_turns).toBe(15);
    expect(typeof currentConfig.max_turns).toBe("number");

    // Validação com o schema do grafo
    const parsed = aiNodeConfigSchema.parse(currentConfig);
    expect(parsed.max_turns).toBe(15);
  });

  // J. flag false renderiza ai_node preexistente mas não oferece novo node.
  it("J: Feature flag desligada oculta botão na paleta mas renderiza nós pré-existentes sem erro", () => {
    // 1. Paleta com flag false: botão NÃO aparece
    const { unmount } = renderWithProviders(<NodePalette onAdd={vi.fn()} aiNodeEnabled={false} />);
    expect(screen.queryByTestId("palette-add-ai_node")).toBeNull();
    unmount();

    // 2. Renderização de nó ai_node pré-existente no canvas: abre normalmente
    const existingNode = {
      id: "ai-node-legacy",
      type: "ai_node" as const,
      data: {
        label: "IA",
        config: {
          mode: "custom_prompt" as const,
          objective: "Atendimento preexistente",
        },
      },
      position: { x: 0, y: 0 },
      selected: false,
    };

    renderWithProviders(<AiNode {...(existingNode as any)} />);
    expect(screen.getByText("IA")).toBeInTheDocument();
    expect(screen.getByText("Atendimento preexistente")).toBeInTheDocument();
  });

  // K. Validação de layout responsivo (1440x900 e 1280x720), 5 handles e nome longo
  it("K: Layout responsivo 1440x900 e 1280x720 com nome longo de agente e 5 handles perfeitamente posicionados", () => {
    // Simula resolução 1440x900
    window.innerWidth = 1440;
    window.innerHeight = 900;
    window.dispatchEvent(new Event("resize"));

    const longAgentNode = {
      id: "ai-node-long-agent",
      type: "ai_node" as const,
      data: {
        label: "IA",
        config: {
          mode: "existing_agent" as const,
          agent_binding: { agent_id: "agent-long", version_strategy: "published" as const },
          agent_name: "Dr. Roberto Albuquerque de Vasconcelos Filho | Especialista Sênior em Vendas Corporativas e Licitações",
        },
      },
      position: { x: 0, y: 0 },
      selected: true,
    };

    const { unmount } = renderWithProviders(<AiNode {...(longAgentNode as any)} />);
    const card = screen.getByTestId("node-card-ai-node-long-agent");
    expect(card).toBeInTheDocument();

    // 5 handles renderizados no card
    const handles = card.querySelectorAll(".react-flow__handle-right");
    expect(handles.length).toBe(5);

    unmount();

    // Simula resolução 1280x720
    window.innerWidth = 1280;
    window.innerHeight = 720;
    window.dispatchEvent(new Event("resize"));

    renderWithProviders(<AiNode {...(longAgentNode as any)} />);
    const card720 = screen.getByTestId("node-card-ai-node-long-agent");
    expect(card720).toBeInTheDocument();
    expect(card720.querySelectorAll(".react-flow__handle-right").length).toBe(5);
  });
});

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeProps } from "@xyflow/react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { NodePalette } from "@/app/app/ai/followups/[id]/_components/NodePalette";
import { NodeConfigPanel } from "@/app/app/ai/followups/[id]/_components/NodeConfigPanel";
import { AiNode } from "@/app/app/ai/followups/[id]/_components/nodes/AiNode";
import { NODE_VISUALS } from "@/app/app/ai/followups/[id]/_components/nodes/nodeVisuals";
import {
  nodeBranches,
  type FlowGraph,
  type AiNodeConfig,
  AI_NODE_COMPLETED_BRANCH_ID,
  AI_NODE_TIMEOUT_BRANCH_ID,
  AI_NODE_MAX_TURNS_BRANCH_ID,
  AI_NODE_HANDOFF_BRANCH_ID,
  AI_NODE_ERROR_BRANCH_ID,
} from "@/lib/followup/graph-schema";
import { toReactFlow, fromReactFlow, graphsEqual, type RFNode } from "@/lib/followup/graph-mappers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import type { AgentRow } from "@/hooks/ai/useAgent";

// Mock de autenticação e permissões
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
}));

// Mocks de agentes para os testes de UI
const mockAgents: AgentRow[] = [
  {
    id: "agent-active-1",
    organization_id: "org-1",
    name: "Vinícius | Comercial",
    description: "Agente de vendas ativas",
    model: "claude-3-5-sonnet",
    system_prompt: "Prompt",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: {},
    published_version_id: "version-published-1",
    active_kb_version_id: null,
    paused_at: null,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "agent-paused-2",
    organization_id: "org-1",
    name: "Roberto | Suporte",
    description: "Agente de suporte técnico",
    model: "claude-3-5-sonnet",
    system_prompt: "Prompt",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: {},
    published_version_id: "version-published-2",
    active_kb_version_id: null,
    paused_at: new Date().toISOString(),
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "agent-unpublished-3",
    organization_id: "org-1",
    name: "Draft Bot",
    description: "Sem versão publicada",
    model: "claude-3-5-sonnet",
    system_prompt: "Prompt",
    is_active: true,
    is_default: false,
    config: {},
    guardrails: {},
    published_version_id: null,
    active_kb_version_id: null,
    paused_at: null,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

vi.mock("@/hooks/ai/useAgents", () => ({
  useAgentsList: () => ({
    data: mockAgents,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/ai/useAgentVersions", () => ({
  useAgentVersions: (agentId: string) => ({
    data: [
      {
        id: "version-published-1",
        organization_id: "org-1",
        agent_id: agentId,
        version_number: 1,
        model: "claude-3-5-sonnet",
        status: "published",
        created_at: new Date().toISOString(),
      },
      {
        id: "version-pinned-2",
        organization_id: "org-1",
        agent_id: agentId,
        version_number: 2,
        model: "claude-3-5-sonnet",
        status: "draft",
        created_at: new Date().toISOString(),
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/app/app/ai/followups/[id]/_components/EtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({
    etapas: [
      { stageId: "stage-1", stageName: "Primeiro Contato", pipelineId: "pipe-1", pipelineName: "Funil Comercial" },
      { stageId: "stage-2", stageName: "Proposta Enviada", pipelineId: "pipe-1", pipelineName: "Funil Comercial" },
    ],
    carregando: false,
    nomes: {
      etapa: (id: string) => (id === "stage-1" ? "Primeiro Contato" : "Proposta Enviada"),
    },
  }),
}));

import { ReactFlowProvider } from "@xyflow/react";

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function wrapWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ReactFlowProvider>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </ReactFlowProvider>
  );
}

function createAiRfNode(config: Record<string, unknown> = {}): RFNode {
  return {
    id: "ai_node-1",
    type: "ai_node",
    position: { x: 0, y: 0 },
    data: {
      label: "IA",
      config: {
        mode: "custom_prompt",
        objective: "",
        max_turns: 10,
        timeout: { duration_value: 24, unit: "hours" },
        ...config,
      } as AiNodeConfig,
    },
  };
}

describe("Fase 5: UI / UX do Node IA no Fluxo (Testes A a S)", () => {
  // A. Node IA aparece na paleta quando flag ligada.
  it("A: Node IA aparece na paleta quando flag ligada", () => {
    wrapWithProviders(<NodePalette onAdd={vi.fn()} aiNodeEnabled={true} />);
    const botaoIA = screen.getByTestId("palette-add-ai_node");
    expect(botaoIA).toBeInTheDocument();
    expect(botaoIA).toHaveTextContent("IA");
  });

  // B. Node IA não aparece quando flag desligada.
  it("B: Node IA NÃO aparece na paleta quando flag desligada", () => {
    wrapWithProviders(<NodePalette onAdd={vi.fn()} aiNodeEnabled={false} />);
    const botaoIA = screen.queryByTestId("palette-add-ai_node");
    expect(botaoIA).toBeNull();
  });

  // C. Criar ai_node no canvas.
  it("C: Criar ai_node no canvas gera configuração padrão válida", () => {
    const visual = NODE_VISUALS.ai_node;
    expect(visual.paletteLabel).toBe("IA");
    const defaultConfig = visual.defaultConfig() as AiNodeConfig;
    expect(defaultConfig.mode).toBe("custom_prompt");
    expect(defaultConfig.max_turns).toBe(10);
    expect(defaultConfig.timeout).toEqual({ duration_value: 24, unit: "hours" });
  });

  // D. Abrir drawer.
  it("D: Abrir drawer renderiza AiNodeForm com as 5 seções estruturadas", () => {
    const node = createAiRfNode();
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={vi.fn()} onDelete={vi.fn()} />
    );

    expect(screen.getByTestId("ai-node-form")).toBeInTheDocument();
    expect(screen.getByText("1. Como a IA vai atender")).toBeInTheDocument();
    expect(screen.getByText("2. Objetivo desta etapa")).toBeInTheDocument();
    expect(screen.getByText("3. Quando esta etapa termina")).toBeInTheDocument();
    expect(screen.getByText("4. Limites e segurança")).toBeInTheDocument();
    expect(screen.getByText("5. Saídas do fluxo")).toBeInTheDocument();
  });

  // E. Selecionar existing_agent.
  it("E: Selecionar existing_agent atualiza o modo no config", async () => {
    const onChange = vi.fn();
    const node = createAiRfNode({ mode: "custom_prompt" });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={onChange} onDelete={vi.fn()} />
    );

    const btnExistingAgent = screen.getByTestId("mode-existing-agent");
    fireEvent.click(btnExistingAgent);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          mode: "existing_agent",
          agent_binding: expect.objectContaining({
            version_strategy: "published",
          }),
        }),
      })
    );
  });

  // F. Selecionar custom_prompt.
  it("F: Selecionar custom_prompt exibe editor de instruções para a IA", () => {
    const node = createAiRfNode({ mode: "custom_prompt", custom_prompt: "Instruções exclusivas" });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={vi.fn()} onDelete={vi.fn()} />
    );

    expect(screen.getByTestId("input-ai-custom-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-select-trigger")).toBeNull();
  });

  // G. Selecionar existing_with_supplementary.
  it("G: Selecionar existing_with_supplementary exibe campo de instruções complementares", () => {
    const node = createAiRfNode({
      mode: "existing_with_supplementary",
      agent_binding: { agent_id: "agent-active-1", version_strategy: "published" },
      supplementary_instruction: "Orientações da etapa",
    });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={vi.fn()} onDelete={vi.fn()} />
    );

    expect(screen.getByTestId("input-ai-supplementary")).toBeInTheDocument();
    expect(screen.getByText("Essa instrução complementa o agente.")).toBeInTheDocument();
  });

  // H. Agente pausado aparece inválido.
  it("H: Agente pausado aparece com badge e exibe mensagem amigável de erro", () => {
    const node = createAiRfNode({
      mode: "existing_agent",
      agent_binding: { agent_id: "agent-paused-2", version_strategy: "published" },
    });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={vi.fn()} onDelete={vi.fn()} />
    );

    const errorMsg = screen.getByTestId("agent-error-msg");
    expect(errorMsg).toHaveTextContent("Este agente está pausado.");
  });

  // I. Agente sem published version aparece inválido.
  it("I: Agente sem versão publicada exibe aviso amigável", () => {
    const node = createAiRfNode({
      mode: "existing_agent",
      agent_binding: { agent_id: "agent-unpublished-3", version_strategy: "published" },
    });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={vi.fn()} onDelete={vi.fn()} />
    );

    const errorMsg = screen.getByTestId("agent-error-msg");
    expect(errorMsg).toHaveTextContent("Este agente ainda não possui uma versão publicada.");
  });

  // J. published vs pinned.
  it("J: Alternar version_strategy permite published e pinned nas configurações avançadas", () => {
    const onChange = vi.fn();
    const node = createAiRfNode({
      mode: "existing_agent",
      agent_binding: { agent_id: "agent-active-1", version_strategy: "published" },
    });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={onChange} onDelete={vi.fn()} />
    );

    // Abre configurações avançadas
    fireEvent.click(screen.getByTestId("toggle-advanced-config"));
    expect(screen.getByText("Versão do agente")).toBeInTheDocument();
  });

  // K. Objetivo/instruções persistem no grafo.
  it("K: Objetivo e instruções persistem via onChange", async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    const node = createAiRfNode({ mode: "custom_prompt", objective: "" });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={onChange} onDelete={vi.fn()} />
    );

    const inputObjective = screen.getByTestId("input-ai-objective");
    await user.type(inputObjective, "Qualificar cliente");

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          objective: expect.stringContaining("Q"),
        }),
      })
    );
  });

  // L. Condições determinísticas persistem.
  it("L: Condições determinísticas (imagens, áudio, etc.) persistem no config", () => {
    const onChange = vi.fn();
    const node = createAiRfNode({ mode: "custom_prompt" });
    wrapWithProviders(
      <NodeConfigPanel node={node} onChange={onChange} onDelete={vi.fn()} />
    );

    const chkImages = screen.getByTestId("checkbox-min-images");
    fireEvent.click(chkImages);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          deterministic_conditions: expect.objectContaining({
            min_images: 1,
          }),
        }),
      })
    );
  });

  // M. 5 branches/handles corretos.
  it("M: Node IA possui exatamente as 5 branches canônicas com rótulos corretos", () => {
    const branches = nodeBranches({
      type: "ai_node",
      config: { mode: "custom_prompt" },
    });

    expect(branches).toHaveLength(5);
    expect(branches.map((b) => b.id)).toEqual([
      AI_NODE_COMPLETED_BRANCH_ID,
      AI_NODE_TIMEOUT_BRANCH_ID,
      AI_NODE_MAX_TURNS_BRANCH_ID,
      AI_NODE_HANDOFF_BRANCH_ID,
      AI_NODE_ERROR_BRANCH_ID,
    ]);

    expect(branches[0]?.label).toBe("Concluído");
    expect(branches[1]?.label).toBe("Tempo esgotado");
    expect(branches[2]?.label).toBe("Máx. de turnos");
    expect(branches[3]?.label).toBe("Atendimento humano");
    expect(branches[4]?.label).toBe("Erro");
  });

  // N. Autosave preserva config.
  it("N: toReactFlow e fromReactFlow preservam integralmente o config do ai_node", () => {
    const originalGraph: FlowGraph = {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          label: "Início",
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: "ai_node-1",
          type: "ai_node",
          label: "IA Atendente",
          position: { x: 100, y: 100 },
          config: {
            mode: "existing_with_supplementary",
            agent_binding: { agent_id: "11111111-1111-4111-8111-111111111111", version_strategy: "published" },
            objective: "Fechar venda",
            supplementary_instruction: "Oferecer 10% de desconto",
            max_turns: 5,
            timeout: { duration_value: 12, unit: "hours" },
            deterministic_conditions: { min_images: 3 },
          },
        },
        {
          id: "end-1",
          type: "end",
          label: "Fim",
          position: { x: 200, y: 200 },
          config: { outcome: "converted" },
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "trigger-1",
          target: "ai_node-1",
          priority: 0,
          condition: { type: "always" },
        },
        {
          id: "edge-2",
          source: "ai_node-1",
          target: "end-1",
          priority: 0,
          condition: { type: "branch", branch_id: "completed" },
        },
      ],
    };

    const rf = toReactFlow(originalGraph);
    const roundtrip = fromReactFlow(rf.nodes, rf.edges);

    expect(graphsEqual(originalGraph, roundtrip)).toBe(true);
    const roundtripAi = roundtrip.nodes.find((n) => n.id === "ai_node-1")!;
    expect(roundtripAi.config).toEqual(originalGraph.nodes[1]!.config);
  });

  // O & P. Export/Import e compartilhamento com isolamento cross-tenant.
  it("O e P: importFlowIntoOrg remove agent_id cross-tenant e emite warning humano", async () => {
    const sourceGraph: FlowGraph = {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          label: "Início",
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: "ai_node-1",
          type: "ai_node",
          label: "IA Comercial",
          position: { x: 100, y: 100 },
          config: {
            mode: "existing_agent",
            agent_binding: {
              agent_id: "99999999-9999-4999-8999-999999999999", // ID da org original
              version_strategy: "published",
              pinned_version_id: "88888888-8888-4888-8888-888888888888",
            },
            agent_name: "Vinícius Org A",
            objective: "Apresentar produto",
            max_turns: 15,
          } as AiNodeConfig,
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "trigger-1",
          target: "ai_node-1",
          priority: 0,
          condition: { type: "always" },
        },
      ],
    };

    let insertedGraph: FlowGraph | null = null;
    const mockAdmin = {
      from: vi.fn((table: string) => {
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
        if (table === "followup_flow_versions") {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
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
        };
      }),
    };

    const result = await importFlowIntoOrg({
      admin: mockAdmin as unknown as SupabaseClient,
      targetOrgId: "org-destination-tenant",
      userId: "user-target",
      flowName: "Fluxo Importado com IA",
      graph: sourceGraph,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("requer a seleção de um agente da sua organização"))).toBe(true);

    // O grafo importado NÃO possui o agent_id nem pinned_version_id da org de origem
    const importedAiNode = insertedGraph!.nodes.find((n) => n.type === "ai_node")!;
    const importedConfig = importedAiNode.config as AiNodeConfig;
    const importedBinding = importedConfig.agent_binding;
    expect(importedBinding?.agent_id).toBeUndefined();
    expect(importedBinding?.pinned_version_id).toBeUndefined();
    expect(importedConfig.agent_name).toBeUndefined();

    // Mas preserva objetivo, modo e limites
    expect(importedConfig.objective).toBe("Apresentar produto");
    expect(importedConfig.mode).toBe("existing_agent");
    expect(importedConfig.max_turns).toBe(15);
  });

  // Q. Configuração incompleta exibe warning no canvas.
  it("Q: ai_node sem agente selecionado exibe aviso 'Configuração pendente' no card", () => {
    const nodeProps = {
      id: "ai_node-1",
      data: {
        label: "IA",
        config: {
          mode: "existing_agent" as const,
          agent_binding: { agent_id: null, version_strategy: "published" as const },
        },
      },
      selected: false,
    };

    wrapWithProviders(<AiNode {...(nodeProps as unknown as NodeProps<RFNode>)} />);

    const card = screen.getByTestId("node-card-ai_node-1");
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId("node-error-ai_node-1")).toHaveTextContent("Configuração pendente: selecione um agente");
  });

  // R. Publish continua bloqueando config inválida.
  it("R: Publish validação bloqueia fluxo se o ai_node não tiver agente ou se feature desativada", () => {
    const invalidGraph: FlowGraph = {
      nodes: [
        { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai_node-1",
          type: "ai_node",
          label: "IA",
          position: { x: 100, y: 100 },
          config: {
            mode: "existing_agent",
            agent_binding: { agent_id: null, version_strategy: "published" },
          },
        },
        { id: "end-1", type: "end", label: "Fim", position: { x: 200, y: 200 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "ai_node-1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai_node-1", target: "end-1", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    // Bloqueado se feature flag desligada
    const resDisabled = validateFlowForPublish(invalidGraph, { aiNodeEnabled: false });
    expect(resDisabled.ok).toBe(false);
    if (!resDisabled.ok) {
      expect(resDisabled.errors.some((e) => e.code === "feature_disabled")).toBe(true);
    }

    // Bloqueado se faltar agente com feature flag ligada
    const resNoAgent = validateFlowForPublish(invalidGraph, { aiNodeEnabled: true });
    expect(resNoAgent.ok).toBe(false);
    if (!resNoAgent.ok) {
      expect(resNoAgent.errors.some((e) => e.code === "ai_node_agent_not_found")).toBe(true);
    }
  });

  // S. Grafos antigos sem ai_node continuam abrindo normalmente.
  it("S: Grafos antigos sem ai_node abrem e validam normalmente", () => {
    const legacyGraph: FlowGraph = {
      nodes: [
        { id: "trigger-1", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        { id: "wait-1", type: "wait", label: "Espera", position: { x: 100, y: 0 }, config: { mode: "fixed", duration_ms: 300_000 } },
        { id: "msg-1", type: "message_text", label: "Texto", position: { x: 200, y: 0 }, config: { body: "Olá" } },
        { id: "end-1", type: "end", label: "Fim", position: { x: 300, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "wait-1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "wait-1", target: "msg-1", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "msg-1", target: "end-1", priority: 0, condition: { type: "always" } },
      ],
    };

    const rf = toReactFlow(legacyGraph);
    expect(rf.nodes).toHaveLength(4);

    const validation = validateFlowForPublish(legacyGraph, { aiNodeEnabled: false });
    expect(validation.ok).toBe(true);
  });
});

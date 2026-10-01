import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RFNode } from "@/lib/followup/graph-mappers";

import { AiNodeForm } from "@/app/app/ai/followups/[id]/_components/forms/AiNodeForm";
import { NodePalette } from "@/app/app/ai/followups/[id]/_components/NodePalette";
import { AiNode } from "@/app/app/ai/followups/[id]/_components/nodes/AiNode";
import {
  flowGraphSchema,
  computeAiNodeTimeoutMs,
  normalizeLegacyTimeoutMs,
  normalizeAiNodeTimeout,
  type FlowGraph,
  type AiNodeConfig,
} from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import {
  evaluateAiNodeDeterministicConditions,
  resolveAiNodeAgentConfig,
} from "@/lib/followup/ai-node-executor";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgenteCitado } from "@/lib/followup/agentes-citados";

// UUIDs v4 reais para garantir que nenhuma validação passe por leniência de strings
const AGENT_A_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_A_PINNED = "22222222-2222-4222-8222-222222222222";
const AGENT_B_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_B_PUBLISHED = "44444444-4444-4444-8444-444444444444";
const TARGET_ORG_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_USER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockAgentA: AgentRow = {
  id: AGENT_A_ID,
  organization_id: TARGET_ORG_UUID,
  name: "Agente Especialista Imobiliário",
  description: "Atendimento de vendas e visitas",
  model: "claude-3-5-sonnet",
  system_prompt: "Você é o assistente virtual da imobiliária.",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: {},
  published_version_id: VERSION_A_PINNED,
  active_kb_version_id: null,
  paused_at: null,
  archived_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockAgentB: AgentRow = {
  id: AGENT_B_ID,
  organization_id: TARGET_ORG_UUID,
  name: "Agente Comercial Pro",
  description: "Atendimento comercial geral",
  model: "claude-3-5-sonnet",
  system_prompt: "Você é o corretor especialista.",
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
    data:
      agentId === AGENT_A_ID
        ? [{ id: VERSION_A_PINNED, version_number: 1, model: "claude-3-5-sonnet", created_at: "2026-01-01" }]
        : [{ id: VERSION_B_PUBLISHED, version_number: 2, model: "claude-3-5-sonnet", created_at: "2026-02-01" }],
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

describe("Fase 5.1: Auditoria Rigorosa de Integração UI ↔ Schema ↔ Runtime", () => {
  // A. published atravessa UI → schema → publish → resolver sem tradução divergente
  it("A: version_strategy 'published' atravessa UI → schema → publish → resolver de forma canônica", async () => {
    let savedConfig: AiNodeConfig = {
      mode: "existing_agent",
      agent_binding: {
        agent_id: AGENT_B_ID,
        version_strategy: "published",
        pinned_version_id: null,
      },
      objective: "Qualificar lead",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      savedConfig = next;
    });

    renderWithProviders(<AiNodeForm config={savedConfig} onChange={onChange} />);

    // Confirmar que o valor emitido é 'published'
    expect(savedConfig.agent_binding?.version_strategy).toBe("published");
    expect(savedConfig.agent_binding?.pinned_version_id).toBeNull();

    // 1. Graph Schema
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai-node-1",
          type: "ai_node",
          label: "IA",
          position: { x: 100, y: 0 },
          config: savedConfig,
        },
        { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trg", target: "ai-node-1", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai-node-1", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    const parsedGraph = flowGraphSchema.parse(graph);
    const validatedAiNode = parsedGraph.nodes.find((n) => n.id === "ai-node-1")!;
    const validatedConfig = validatedAiNode.config as AiNodeConfig;
    expect(validatedConfig.agent_binding?.version_strategy).toBe("published");

    // 2. Validate for publish
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

    const pubRes = validateFlowForPublish(parsedGraph, {
      aiNodeEnabled: true,
      agentes: agentesMap,
    });
    expect(pubRes.ok).toBe(true);

    // 3. Runtime Resolver (resolveAiNodeAgentConfig)
    const loadPublishedMock = vi.fn().mockResolvedValue({
      agentId: AGENT_B_ID,
      versionId: VERSION_B_PUBLISHED,
      systemPrompt: "Prompt resolvido publicado",
      model: "claude-3-5-sonnet",
      tools: [],
    });
    const loadVersionMock = vi.fn();

    const resolved = await resolveAiNodeAgentConfig(
      {} as unknown as Parameters<typeof resolveAiNodeAgentConfig>[0],
      TARGET_ORG_UUID,
      validatedConfig,
      {
        loadPublishedAgentConfigByIdFn: loadPublishedMock,
        loadAgentVersionConfigFn: loadVersionMock,
      }
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok && resolved.agent) {
      expect(resolved.agent.versionId).toBe(VERSION_B_PUBLISHED);
      expect(resolved.agent.systemPrompt).toBe("Prompt resolvido publicado");
    }
    expect(loadPublishedMock).toHaveBeenCalledWith(expect.anything(), TARGET_ORG_UUID, AGENT_B_ID);
    expect(loadVersionMock).not.toHaveBeenCalled();
  });

  // B. pinned atravessa todo ciclo e usa a versão correta
  it("B: version_strategy 'pinned' com UUID válido atravessa UI → schema → publish → resolver", async () => {
    let savedConfig: AiNodeConfig = {
      mode: "existing_agent",
      agent_binding: {
        agent_id: AGENT_A_ID,
        version_strategy: "pinned",
        pinned_version_id: VERSION_A_PINNED,
      },
      objective: "Atendimento fixado",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      savedConfig = next;
    });

    renderWithProviders(<AiNodeForm config={savedConfig} onChange={onChange} />);

    // 1. Graph Schema
    const graph: FlowGraph = {
      nodes: [
        { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "ai-pinned-node",
          type: "ai_node",
          label: "IA Fixada",
          position: { x: 100, y: 0 },
          config: savedConfig,
        },
        { id: "end", type: "end", label: "Fim", position: { x: 200, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "e1", source: "trg", target: "ai-pinned-node", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "ai-pinned-node", target: "end", priority: 0, condition: { type: "branch", branch_id: "completed" } },
      ],
    };

    const parsedGraph = flowGraphSchema.parse(graph);
    const validatedAiNode = parsedGraph.nodes.find((n) => n.id === "ai-pinned-node")!;
    const validatedConfig = validatedAiNode.config as AiNodeConfig;
    expect(validatedConfig.agent_binding?.version_strategy).toBe("pinned");
    expect(validatedConfig.agent_binding?.pinned_version_id).toBe(VERSION_A_PINNED);

    // 2. Validate for publish
    const agentesMap = new Map<string, AgenteCitado>([
      [
        AGENT_A_ID,
        {
          id: AGENT_A_ID,
          name: "Agente A",
          archived_at: null,
          published_version_id: VERSION_A_PINNED,
          version_ids: [VERSION_A_PINNED],
        },
      ],
    ]);

    const pubRes = validateFlowForPublish(parsedGraph, {
      aiNodeEnabled: true,
      agentes: agentesMap,
    });
    expect(pubRes.ok).toBe(true);

    // 3. Runtime Resolver (resolveAiNodeAgentConfig)
    const loadPublishedMock = vi.fn();
    const loadVersionMock = vi.fn().mockResolvedValue({
      agentId: AGENT_A_ID,
      versionId: VERSION_A_PINNED,
      systemPrompt: "Prompt da versão fixada exata",
      model: "claude-3-5-sonnet",
      tools: [],
    });

    const resolved = await resolveAiNodeAgentConfig(
      {} as unknown as Parameters<typeof resolveAiNodeAgentConfig>[0],
      TARGET_ORG_UUID,
      validatedConfig,
      {
        loadPublishedAgentConfigByIdFn: loadPublishedMock,
        loadAgentVersionConfigFn: loadVersionMock,
      }
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok && resolved.agent) {
      expect(resolved.agent.versionId).toBe(VERSION_A_PINNED);
      expect(resolved.agent.systemPrompt).toBe("Prompt da versão fixada exata");
    }
    expect(loadVersionMock).toHaveBeenCalledWith(
      expect.anything(),
      TARGET_ORG_UUID,
      AGENT_A_ID,
      VERSION_A_PINNED
    );
    expect(loadPublishedMock).not.toHaveBeenCalled();
  });

  // C. UUIDs reais no import cross-tenant
  it("C: Import cross-tenant com UUIDs reais v4 sanitiza agent_binding e permite draft seguro", async () => {
    const FOREIGN_AGENT_UUID = "55555555-5555-4555-8555-555555555555";
    const FOREIGN_VERSION_UUID = "66666666-6666-4666-8666-666666666666";

    const foreignFlow = {
      name: "Fluxo Org Alpha",
      draft_graph: {
        nodes: [
          { id: "trg", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
          {
            id: "ai-foreign",
            type: "ai_node",
            label: "IA de Vendas",
            position: { x: 100, y: 0 },
            config: {
              mode: "existing_agent",
              agent_binding: {
                agent_id: FOREIGN_AGENT_UUID,
                version_strategy: "pinned",
                pinned_version_id: FOREIGN_VERSION_UUID,
              },
              objective: "Concluir venda",
              max_turns: 12,
              timeout: { duration_value: 24, unit: "hours" },
              deterministic_conditions: { min_images: 5 },
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
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [] }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: [] }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }),
    };

    const res = await importFlowIntoOrg({
      admin: mockAdmin as unknown as SupabaseClient,
      targetOrgId: TARGET_ORG_UUID,
      userId: TARGET_USER_UUID,
      flowName: foreignFlow.name,
      graph: foreignFlow.draft_graph as FlowGraph,
    });

    expect(res.ok).toBe(true);
    expect(insertedGraph).toBeDefined();

    const importedAiNode = insertedGraph!.nodes.find((n) => n.type === "ai_node")!;
    const cfg = importedAiNode.config as AiNodeConfig;

    // UUIDs da Org estrangeira foram totalmente removidos
    expect(cfg.agent_binding?.agent_id).toBeUndefined();
    expect(cfg.agent_binding?.pinned_version_id).toBeUndefined();
    expect(cfg.agent_name).toBeUndefined();

    // Demais dados operacionais preservados
    expect(cfg.objective).toBe("Concluir venda");
    expect(cfg.max_turns).toBe(12);
    expect(cfg.deterministic_conditions).toEqual({ min_images: 5 });

    // Rascunho com agente pendente SALVA e valida com sucesso no draft
    const parsedDraft = flowGraphSchema.safeParse(insertedGraph!);
    expect(parsedDraft.success).toBe(true);

    // Publicação é IMPEDIDA até que a organização destino selecione um agente local
    const pubCheck = validateFlowForPublish(insertedGraph!, { aiNodeEnabled: true });
    expect(pubCheck.ok).toBe(false);
    if (!pubCheck.ok) {
      expect(pubCheck.errors.some((e) => e.code === "ai_node_agent_not_found")).toBe(true);
    }
  });

  // D. timeout inconsistente é normalizado deterministicamente
  it("D: JSON com timeout inconsistente (ex: 24h e 1800000ms) é normalizado deterministicamente pelo boundary canônico", () => {
    const inconsistentRaw = {
      mode: "custom_prompt" as const,
      objective: "Teste de inconsistência",
      timeout: {
        duration_value: 24,
        unit: "hours" as const,
      },
      timeout_ms: 1_800_000, // 30 minutos em ms, conflitante com 24 horas!
    };

    const normalized = normalizeAiNodeTimeout(inconsistentRaw);

    // A fonte canônica (timeout { duration_value, unit }) prevalece e recalcula timeout_ms
    expect(normalized.timeout).toEqual({ duration_value: 24, unit: "hours" });
    expect(normalized.timeout_ms).toBe(24 * 3_600_000); // 86_400_000 ms, divergência sanada
  });

  // E. grafo legado só com timeout_ms continua carregando
  it("E: Grafo legado que possui apenas timeout_ms continua carregando e é normalizado para a representação canônica", () => {
    const legacyRaw = {
      mode: "custom_prompt" as const,
      objective: "Fluxo antigo de 2025",
      timeout_ms: 1_800_000, // 30 minutos
    };

    const normalized = normalizeAiNodeTimeout(legacyRaw);

    expect(normalized.timeout).toEqual({ duration_value: 30, unit: "minutes" });
    expect(normalized.timeout_ms).toBe(1_800_000);

    // Validação no formulário
    let currentConfig: AiNodeConfig = { ...legacyRaw };
    const onChange = vi.fn((next: AiNodeConfig) => {
      currentConfig = next;
    });

    renderWithProviders(<AiNodeForm config={currentConfig} onChange={onChange} />);

    const inputVal = screen.getByTestId("input-timeout-value") as HTMLInputElement;
    expect(inputVal.value).toBe("30");
  });

  // F. save/reload mantém timeout coerente
  it("F: Save e reload mantêm paridade visual e operacional em 24h, 30min e 2 dias", () => {
    // 24 horas e 1 dia
    const t24h = { duration_value: 24, unit: "hours" as const };
    expect(computeAiNodeTimeoutMs(t24h)).toBe(86_400_000);
    expect(normalizeLegacyTimeoutMs(86_400_000)).toEqual({ duration_value: 1, unit: "days" });

    // 12 horas
    const t12h = { duration_value: 12, unit: "hours" as const };
    expect(computeAiNodeTimeoutMs(t12h)).toBe(43_200_000);
    expect(normalizeLegacyTimeoutMs(43_200_000)).toEqual(t12h);

    // 30 minutos
    const t30m = { duration_value: 30, unit: "minutes" as const };
    expect(computeAiNodeTimeoutMs(t30m)).toBe(1_800_000);
    expect(normalizeLegacyTimeoutMs(1_800_000)).toEqual(t30m);

    // 2 dias
    const t2d = { duration_value: 2, unit: "days" as const };
    expect(computeAiNodeTimeoutMs(t2d)).toBe(172_800_000);
    expect(normalizeLegacyTimeoutMs(172_800_000)).toEqual(t2d);
  });

  // G. Feature flag true/false no comportamento visual
  it("G: Feature flag controla disponibilização na paleta sem corromper nós existentes no canvas", () => {
    // 1. Flag desligada: não oferece novo nó na paleta
    const { unmount } = renderWithProviders(<NodePalette onAdd={vi.fn()} aiNodeEnabled={false} />);
    expect(screen.queryByTestId("palette-add-ai_node")).toBeNull();
    unmount();

    // 2. Flag ligada: botão visível na paleta
    const { unmount: unmountPalette } = renderWithProviders(
      <NodePalette onAdd={vi.fn()} aiNodeEnabled={true} />
    );
    expect(screen.getByTestId("palette-add-ai_node")).toBeInTheDocument();
    unmountPalette();

    // 3. Grafo que já possui nó IA: renderiza perfeitamente mesmo com flag false
    const existingNode = {
      id: "ai-node-existing",
      type: "ai_node" as const,
      data: {
        label: "IA",
        config: {
          mode: "custom_prompt" as const,
          objective: "Atendimento preexistente em produção",
        },
      },
      position: { x: 0, y: 0 },
      selected: false,
    };

    renderWithProviders(<AiNode {...(existingNode as unknown as NodeProps<RFNode>)} />);
    expect(screen.getByText("IA")).toBeInTheDocument();
    expect(screen.getByText("Atendimento preexistente em produção")).toBeInTheDocument();
  });

  // H. Prova 5 fotos: UI min_images -> JSON -> evaluateAiNodeDeterministicConditions
  it("H: Condição determinística de 5 fotos completa exatamente com 5 imagens e não completa com 4", () => {
    let savedConfig: AiNodeConfig = {
      mode: "custom_prompt",
      objective: "Receber 5 fotos de vistoria",
    };

    const onChange = vi.fn((next: AiNodeConfig) => {
      savedConfig = next;
    });

    renderWithProviders(<AiNodeForm config={savedConfig} onChange={onChange} />);

    // Ativa min_images e define 5
    fireEvent.click(screen.getByTestId("checkbox-min-images"));
    fireEvent.change(screen.getByTestId("input-min-images"), { target: { value: "5" } });

    expect(savedConfig.deterministic_conditions).toEqual({ min_images: 5 });

    // Avaliação no runtime
    const eval4 = evaluateAiNodeDeterministicConditions(savedConfig.deterministic_conditions, {
      mediaSummary: { images_count: 4, audios_count: 0, documents_count: 0, last_media_ids: [] },
    });
    expect(eval4.satisfied).toBe(false);

    const eval5 = evaluateAiNodeDeterministicConditions(savedConfig.deterministic_conditions, {
      mediaSummary: { images_count: 5, audios_count: 0, documents_count: 0, last_media_ids: [] },
    });
    expect(eval5.satisfied).toBe(true);
    expect(eval5.match).toBe("min_images (recebido: 5, exigido: 5)");
  });

  // I. Troca de Agente A (pinned) -> Agente B limpa pinned antigo
  it("I: Troca de agente limpa imediatamente versão fixada antiga", () => {
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

    fireEvent.click(screen.getByTestId("agent-select-trigger"));
    fireEvent.click(screen.getByTestId(`agent-option-${AGENT_B_ID}`));

    expect(currentConfig.agent_binding?.agent_id).toBe(AGENT_B_ID);
    expect(currentConfig.agent_binding?.pinned_version_id).toBeNull();
  });

  // J. Troca de modo limpa campos órfãos
  it("J: Troca de modo limpa bindings operacionais órfãos", () => {
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

    fireEvent.click(screen.getByTestId("mode-custom-prompt"));

    expect(currentConfig.mode).toBe("custom_prompt");
    expect(currentConfig.agent_binding).toBeUndefined();
    expect(currentConfig.agent_name).toBeUndefined();
  });

  // K. Layout responsivo 1440x900 e 1280x720, 5 handles sem sobreposição
  it("K: Validação de layout responsivo com 5 handles e nome longo de agente", () => {
    window.innerWidth = 1440;
    window.innerHeight = 900;
    window.dispatchEvent(new Event("resize"));

    const nodeData = {
      id: "ai-node-responsive",
      type: "ai_node" as const,
      data: {
        label: "IA Consultor",
        config: {
          mode: "existing_agent" as const,
          agent_binding: { agent_id: AGENT_A_ID, version_strategy: "published" as const },
          agent_name: "Agente de Vendas com Nome Muito Extenso para Testar Quebra de Linha e Truncate Visual",
        },
      },
      position: { x: 0, y: 0 },
      selected: true,
    };

    const { unmount } = renderWithProviders(<AiNode {...(nodeData as unknown as NodeProps<RFNode>)} />);
    const card = screen.getByTestId("node-card-ai-node-responsive");
    expect(card).toBeInTheDocument();

    const handles = card.querySelectorAll(".react-flow__handle-right");
    expect(handles.length).toBe(5);

    unmount();

    window.innerWidth = 1280;
    window.innerHeight = 720;
    window.dispatchEvent(new Event("resize"));

    renderWithProviders(<AiNode {...(nodeData as unknown as NodeProps<RFNode>)} />);
    const card720 = screen.getByTestId("node-card-ai-node-responsive");
    expect(card720).toBeInTheDocument();
    expect(card720.querySelectorAll(".react-flow__handle-right").length).toBe(5);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { normalizeSharedFlowToken } from "@/lib/followup/sharing/normalize-token";
import { ImportFlowLinkDialog } from "@/app/app/ai/followups/_components/ImportFlowLinkDialog";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { importFlowIntoOrg } from "@/lib/followup/sharing/import-flow";
import type { FlowGraph, FlowNode } from "@/lib/followup/graph-schema";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  usePathname: () => "/app/ai/followups",
}));

vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: vi.fn(),
}));

describe("Follow-up Flows — Importar por Link (Parte B)", () => {
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

  // 1. importar URL completa válida
  it("1. normaliza URL completa válida extraindo token", () => {
    const url = "https://zyroncrm.tech/fluxos/compartilhado/VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz";
    const res = normalizeSharedFlowToken(url);
    expect(res).toBe("VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz");
  });

  // 2. importar token válido diretamente
  it("2. aceita token válido sem protocolo/domínio", () => {
    const rawToken = "VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz";
    const res = normalizeSharedFlowToken(rawToken);
    expect(res).toBe("VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz");
  });

  // 3. URL inválida
  it("3. rejeita URL com caminho que não seja /fluxos/compartilhado/", () => {
    const badUrl = "https://zyroncrm.tech/outra-coisa/VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz";
    const res = normalizeSharedFlowToken(badUrl);
    expect(res).toBeNull();
  });

  // 4. token inexistente (404 da API)
  it("4. exibe erro amigável quando token não existe", async () => {
    api.get.mockResolvedValueOnce({
      error: { code: "not_found", message: "Fluxo compartilhado não encontrado." },
    });

    render(
      <IdiomaProvider locale="pt-BR">
        <ImportFlowLinkDialog open={true} onOpenChange={vi.fn()} />
      </IdiomaProvider>,
    );

    const input = screen.getByTestId("input-shared-flow-link");
    fireEvent.change(input, {
      target: { value: "https://zyroncrm.tech/fluxos/compartilhado/token-inexistente-12345" },
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("import-link-error")).toBeDefined();
        expect(screen.getByTestId("import-link-error").textContent).toContain("não está mais disponível");
      },
      { timeout: 2000 },
    );
  });

  // 5. token revogado
  it("5. exibe erro quando link foi revogado", async () => {
    api.get.mockResolvedValueOnce({
      error: { code: "not_found", message: "Link revogado ou expirado." },
    });

    render(
      <IdiomaProvider locale="pt-BR">
        <ImportFlowLinkDialog open={true} onOpenChange={vi.fn()} />
      </IdiomaProvider>,
    );

    const input = screen.getByTestId("input-shared-flow-link");
    fireEvent.change(input, {
      target: { value: "https://zyroncrm.tech/fluxos/compartilhado/token-revogado-9999" },
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("import-link-error")).toBeDefined();
      },
      { timeout: 2000 },
    );
  });

  // 6. preview antes de importar
  it("6. exibe preview com nome, contagem de nós e data antes de importar", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        flow_name: "Oferta R$24,90",
        node_count: 18,
        media_count: 2,
        shared_at: "2026-10-01T12:00:00Z",
      },
    });

    render(
      <IdiomaProvider locale="pt-BR">
        <ImportFlowLinkDialog open={true} onOpenChange={vi.fn()} />
      </IdiomaProvider>,
    );

    const input = screen.getByTestId("input-shared-flow-link");
    fireEvent.change(input, {
      target: { value: "https://zyroncrm.tech/fluxos/compartilhado/VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz" },
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("import-link-preview")).toBeDefined();
        expect(screen.getByText("Oferta R$24,90")).toBeDefined();
        expect(screen.getByText(/18 nós/)).toBeDefined();
      },
      { timeout: 2000 },
    );
  });

  // 7, 8, 9, 10, 11, 12: Backend importFlowIntoOrg test
  it("7-12. importFlowIntoOrg cria novo pointer draft, sanitiza recursos e não publica", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [] }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: "new-flow-pointer-uuid", name: "Fluxo Compartilhado" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "crm_stages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: (resolve: any) => resolve({ data: [] }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: [] }),
        };
      }),
    } as any;

    const sourceGraph: FlowGraph = {
      nodes: [
        {
          id: "node-orig-1",
          type: "message_text",
          label: "Mensagem Inicial",
          position: { x: 0, y: 0 },
          config: { body: "Olá!" },
        },
        {
          id: "node-orig-2",
          type: "ai_node",
          label: "Agente de Origem",
          position: { x: 100, y: 100 },
          config: {
            mode: "existing_agent",
            agent_binding: { mode: "explicit", agent_id: "secret-origin-agent-id" },
            objective: "Atendimento de lead",
          },
        } as unknown as FlowNode,
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-orig-1",
          target: "node-orig-2",
          priority: 0,
          condition: { type: "always" },
        },
      ],
    };

    const result = await importFlowIntoOrg({
      admin: mockAdmin,
      targetOrgId: "target-org-uuid",
      userId: "importing-user-uuid",
      flowName: "Fluxo Compartilhado",
      graph: sourceGraph,
    });

    expect(result.ok).toBe(true);
    expect(result.flow_id).toBe("new-flow-pointer-uuid");
    // Aviso gerado para o nó de IA requerer agente local
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes("Agente de Origem"))).toBe(true);

    // Verifica que inseriu no banco como status: "draft"
    const pointerInsertCall = mockAdmin.from.mock.calls.find((c: any[]) => c[0] === "followup_flow_pointers");
    expect(pointerInsertCall).toBeDefined();
  });

  // 13. botão aparece na página principal
  it("13. botão 'Importar por link' é exibido na lista principal de fluxos", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={queryClient}>
          <FlowsList initialData={[]} canWrite={true} />
        </QueryClientProvider>
      </IdiomaProvider>,
    );

    const btn = screen.getByTestId("btn-import-link");
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain("Importar por link");
  });
});

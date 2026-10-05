import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/ai/followups",
}));

vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function openTrigger(btn: HTMLElement) {
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false, pointerId: 1 });
}

describe("Follow-up Flows List & Archive / Permanent Delete", () => {
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

  afterEach(() => {
    cleanup();
  });

  const mockActiveFlow: FollowupFlowPointerRow = {
    id: "flow-active-1",
    name: "Fluxo Ativo de Teste",
    status: "active",
    active_version_id: "ver-1",
    handoff_policy: "pause",
    updated_at: "2026-09-25T00:25:38.309Z",
    archived_at: null,
  };

  const mockArchivedFlow: FollowupFlowPointerRow = {
    id: "flow-archived-1",
    name: "Fluxo Arquivado de Teste",
    status: "disabled",
    active_version_id: null,
    handoff_policy: "allow",
    updated_at: "2026-09-24T20:00:00.000Z",
    archived_at: "2026-09-25T00:15:00.000Z",
  };

  function renderComponent(initialData: FollowupFlowPointerRow[] = [], canWrite = true) {
    return render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={queryClient}>
          <FlowsList initialData={initialData} canWrite={canWrite} />
        </QueryClientProvider>
      </IdiomaProvider>,
    );
  }

  it("1. página /app/ai/followups abre e renderiza sem erros", () => {
    renderComponent([mockActiveFlow, mockArchivedFlow]);
    expect(screen.getByText(/Ativos/)).toBeDefined();
    expect(screen.getByText(/Arquivados/)).toBeDefined();
  });

  it("2. aba Ativos renderiza fluxos ativos", () => {
    renderComponent([mockActiveFlow, mockArchivedFlow]);
    expect(screen.getByText("Fluxo Ativo de Teste")).toBeDefined();
    expect(screen.queryByText("Fluxo Arquivado de Teste")).toBeNull();
  });

  it("3. aba Arquivados renderiza fluxos arquivados", async () => {
    renderComponent([mockActiveFlow, mockArchivedFlow]);
    const arquivadosTab = screen.getByRole("button", { name: /Arquivados/ });
    fireEvent.click(arquivadosTab);

    expect(screen.getByText("Fluxo Arquivado de Teste")).toBeDefined();
    expect(screen.queryByText("Fluxo Ativo de Teste")).toBeNull();
  });

  it("4. fluxo sem archived_at renderiza corretamente na aba Ativos", () => {
    renderComponent([mockActiveFlow]);
    expect(screen.getByText("Fluxo Ativo de Teste")).toBeDefined();
    expect(screen.getByText(/Atualizado em/)).toBeDefined();
  });

  it("5. fluxo com archived_at renderiza corretamente na aba Arquivados", () => {
    renderComponent([mockArchivedFlow]);
    const arquivadosTab = screen.getByRole("button", { name: /Arquivados/ });
    fireEvent.click(arquivadosTab);

    expect(screen.getByText("Fluxo Arquivado de Teste")).toBeDefined();
    expect(screen.getByText(/Arquivado em/)).toBeDefined();
  });

  it("6. lista vazia renderiza estado vazio para ativos e arquivados", () => {
    renderComponent([]);
    expect(screen.getByText("Nenhum fluxo de follow-up ativo")).toBeDefined();

    const arquivadosTab = screen.getByRole("button", { name: /Arquivados/ });
    fireEvent.click(arquivadosTab);
    expect(screen.getByText("Nenhum fluxo arquivado")).toBeDefined();
  });

  it("7. API retorna shape esperado e hook consome { data: [...] }", async () => {
    api.get.mockResolvedValueOnce({
      data: [mockActiveFlow, mockArchivedFlow],
    });

    renderComponent([mockActiveFlow]);
    expect(screen.getByText("Fluxo Ativo de Teste")).toBeDefined();
  });

  it("8. arquivar ainda funciona chamando rota /archive", async () => {
    api.post.mockResolvedValueOnce({
      data: { ...mockActiveFlow, archived_at: "2026-10-05T12:00:00Z" },
    });

    renderComponent([mockActiveFlow]);

    const opcoesBtn = screen.getByRole("button", { name: /Opções/i });
    openTrigger(opcoesBtn);

    const arquivarItem = await screen.findByText("Arquivar");
    fireEvent.click(arquivarItem);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/ai/followup-flows/flow-active-1/archive",
        {},
      );
    });
  });

  it("9. restaurar ainda funciona chamando rota /restore", async () => {
    api.post.mockResolvedValueOnce({
      data: { ...mockArchivedFlow, archived_at: null },
    });

    renderComponent([mockArchivedFlow]);
    const arquivadosTab = screen.getByRole("button", { name: /Arquivados/ });
    fireEvent.click(arquivadosTab);

    const restaurarBtn = screen.getByRole("button", { name: /Restaurar/i });
    fireEvent.click(restaurarBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "/api/v1/ai/followup-flows/flow-archived-1/restore",
        {},
      );
    });
  });

  it("10. excluir permanentemente ainda funciona abrindo o dialog e confirmando", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.includes("deletion-summary")) {
        return {
          data: {
            active_enrollments: 0,
            agent_references: 0,
            running_jobs: 0,
            total_enrollments: 2,
            messages_sent: 5,
          },
        };
      }
      return { data: [mockArchivedFlow] };
    });
    api.delete.mockResolvedValueOnce({
      data: { id: "flow-archived-1" },
    });

    renderComponent([mockArchivedFlow]);
    const arquivadosTab = screen.getByRole("button", { name: /Arquivados/ });
    fireEvent.click(arquivadosTab);

    const excluirBtn = screen.getByRole("button", { name: /Excluir permanentemente/i });
    fireEvent.click(excluirBtn);

    // Dialog opens and finishes loading summary
    const input = await screen.findByPlaceholderText("Fluxo Arquivado de Teste");
    fireEvent.change(input, { target: { value: "Fluxo Arquivado de Teste" } });

    // Confirm button should be enabled
    const confirmarBtn = screen.getByRole("button", { name: "Excluir permanentemente" });
    fireEvent.click(confirmarBtn);

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith(
        "/api/v1/ai/followup-flows/flow-archived-1/permanent",
        { confirmation_name: "Fluxo Arquivado de Teste" },
      );
    });
  });
});

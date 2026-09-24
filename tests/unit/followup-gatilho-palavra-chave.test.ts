import { describe, expect, it, vi } from "vitest";
import {
  casarPalavraChave,
  avaliarGatilhoPalavraChave,
} from "@/lib/followup/gatilho-palavra-chave";

vi.mock("@/lib/followup/enroll", () => ({
  enrollFollowupFlow: vi.fn(async (_admin, input) => ({
    ok: true,
    enrollment: { id: "enr-123", ...input },
  })),
}));

describe("Gatilho por Palavra-Chave — Casamento de Texto (casarPalavraChave)", () => {
  it("modo exact: casa texto exato", () => {
    const res = casarPalavraChave("fluxo123", {
      keywords: ["fluxo123"],
      match_mode: "exact",
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("modo exact: não casa se houver palavras adicionais", () => {
    const res = casarPalavraChave("quero o fluxo123 por favor", {
      keywords: ["fluxo123"],
      match_mode: "exact",
    });
    expect(res.casou).toBe(false);
  });

  it("modo contains: casa se o texto contiver a palavra-chave em qualquer posição", () => {
    const res = casarPalavraChave("olá, quero o fluxo123 agora", {
      keywords: ["fluxo123"],
      match_mode: "contains",
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("modo starts_with: casa se o texto começar com a palavra-chave", () => {
    const res = casarPalavraChave("fluxo123 por favor", {
      keywords: ["fluxo123"],
      match_mode: "starts_with",
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("modo starts_with: não casa se a palavra-chave estiver no meio", () => {
    const res = casarPalavraChave("olá fluxo123", {
      keywords: ["fluxo123"],
      match_mode: "starts_with",
    });
    expect(res.casou).toBe(false);
  });

  it("case insensitive por padrão: maiúsculas e minúsculas casam igualmente", () => {
    const res = casarPalavraChave("FLUXO123", {
      keywords: ["fluxo123"],
      case_sensitive: false,
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("case sensitive: rejeita se a caixa diferir", () => {
    const res = casarPalavraChave("FLUXO123", {
      keywords: ["fluxo123"],
      case_sensitive: true,
    });
    expect(res.casou).toBe(false);

    const resExato = casarPalavraChave("fluxo123", {
      keywords: ["fluxo123"],
      case_sensitive: true,
    });
    expect(resExato.casou).toBe(true);
  });

  it("trim de espaços: remove espaços extras no início e fim do texto e da palavra-chave", () => {
    const res = casarPalavraChave("   fluxo123   ", {
      keywords: ["  fluxo123  "],
      match_mode: "exact",
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("múltiplas palavras-chave: dispara se qualquer uma casar", () => {
    const res = casarPalavraChave("quero fotos", {
      keywords: ["fluxo123", "quero fotos", "newborn"],
      match_mode: "exact",
    });
    expect(res.casou).toBe(true);
    expect(res.palavraCasada).toBe("quero fotos");
  });

  it("mensagem que não casa nenhuma palavra-chave: não dispara", () => {
    const res = casarPalavraChave("mensagem qualquer sem relação", {
      keywords: ["fluxo123", "quero fotos"],
      match_mode: "contains",
    });
    expect(res.casou).toBe(false);
  });

  it("texto vazio ou nulo: não dispara", () => {
    expect(casarPalavraChave("", { keywords: ["teste"] }).casou).toBe(false);
    expect(casarPalavraChave("   ", { keywords: ["teste"] }).casou).toBe(false);
    expect(casarPalavraChave(null, { keywords: ["teste"] }).casou).toBe(false);
  });
});

describe("Gatilho por Palavra-Chave — Execução e Isolamento (avaliarGatilhoPalavraChave)", () => {
  const ORG_ID = "11111111-1111-4111-8111-111111111111";
  const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
  const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
  const POINTER_ID = "44444444-4444-4444-8444-444444444444";
  const VERSION_ID = "55555555-5555-4555-8555-555555555555";

  it("ignora fluxos desativados ou sem versão publicada", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({
                    data: [
                      // Status draft ou disabled não devem vir
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-1",
      texto: "fluxo123",
    });

    expect(res.disparou).toBe(false);
    expect(res.motivo).toBe("sem_fluxos_ativos");
  });

  it("dispara com sucesso quando palavra-chave casa e passa replaceActive: true", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({
                    data: [
                      {
                        id: POINTER_ID,
                        name: "Fluxo de Vendas",
                        status: "active",
                        active_version_id: VERSION_ID,
                        trigger_config: {
                          kind: "keyword",
                          keywords: ["fluxo123"],
                          match_mode: "exact",
                        },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: () => Promise.resolve({ error: null }),
            update: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              }),
            }),
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-1",
      texto: "fluxo123",
    });

    expect(res.disparou).toBe(true);
    expect(res.pointerId).toBe(POINTER_ID);
    expect(res.palavraCasada).toBe("fluxo123");
  });

  it("idempotência: rejeita message_id duplicado se a chave já existir (erro 23505)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => Promise.resolve({
                    data: [
                      {
                        id: POINTER_ID,
                        name: "Fluxo de Vendas",
                        status: "active",
                        active_version_id: VERSION_ID,
                        trigger_config: {
                          kind: "keyword",
                          keywords: ["fluxo123"],
                          match_mode: "exact",
                        },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "idempotency_keys") {
          return {
            insert: () => Promise.resolve({ error: { code: "23505", message: "duplicate key" } }),
          };
        }
        return {};
      }),
    };

    const res = await avaliarGatilhoPalavraChave(mockAdmin as never, {
      organizationId: ORG_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      messageId: "msg-1",
      texto: "fluxo123",
    });

    expect(res.disparou).toBe(false);
    expect(res.motivo).toBe("message_already_processed");
    expect(res.palavraCasada).toBe("fluxo123");
  });
});

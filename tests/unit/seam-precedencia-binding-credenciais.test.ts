/**
 * Testes de regressão: Precedência de resolução de credenciais e bindings no seam (runModelCall).
 *
 * Garante que:
 * 1. Bug corrigido: quando a org tem default anthropic (sem credencial), mas há binding
 *    específico do ponto (ex: ai_node -> openai) com credencial válida, o binding vence e
 *    o seam NÃO exige credencial do provider padrão da organização.
 * 2. Sem binding: fallback da org continua funcionando normalmente quando há credencial.
 * 3. Existing agent: llmOverride explícito do agente continua tendo precedência.
 * 4. Nenhuma credencial válida: LlmNotConfiguredError continua sendo disparado.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "sk-decrypted-test-key",
  byteaToBuffer: (val: unknown) => (Buffer.isBuffer(val) ? val : Buffer.from(String(val))),
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { LlmNotConfiguredError } from "@/lib/agent-engine/edge/llm/credentials";

const ORG_ID = "56313621-8d2e-4682-b087-743c77e8aaca";
const CRED_OPENAI_ID = "73fbb6f4-5fd5-4d6a-b28d-522d02d8b7fe";

function criarRegistrySpiao() {
  const chamadas: Array<{ provider: string; apiKey: string; modelId: string }> = [];
  const fabrica = (provider: string) => (apiKey: string, modelId: string) => {
    chamadas.push({ provider, apiKey, modelId });
    return {
      specificationVersion: "v3",
      provider,
      modelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "CUSTOM PROMPT OK — teste" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never;
  };

  return {
    chamadas,
    registry: {
      anthropic: fabrica("anthropic"),
      openai: fabrica("openai"),
      openrouter: fabrica("openrouter"),
    },
  };
}

describe("Precedência de resolução no seam runModelCall", () => {
  it("CASO 1 — BUG ATUAL: org default anthropic sem credencial, binding ai_node openai/gpt-4o com credencial válida -> binding vence e openai é chamada", async () => {
    const { registry, chamadas } = criarRegistrySpiao();

    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        // Query de settings / orcamento da organização
        if (sql.includes("settings->'llm'")) {
          return {
            rows: [
              {
                llm: {
                  provider: "anthropic",
                  default_model: "claude-sonnet-5",
                  params: {},
                  enabled_models: [],
                },
                teto: null,
                modo: "off",
                efetivo_em: null,
                limiar_pct: 80,
              },
            ],
          };
        }

        // Query de bindings do ponto (ai_purpose_bindings)
        if (sql.includes("from ai_purpose_bindings")) {
          return {
            rows: [
              {
                purpose: "ai_node",
                provider: "openai",
                credential_id: CRED_OPENAI_ID,
                model_id: "gpt-4o",
                base_url: null,
                is_enabled: true,
              },
            ],
          };
        }

        // Query de credenciais (ai_provider_credentials)
        if (sql.includes("from ai_provider_credentials")) {
          const credId = params[1];
          const provider = params[1];

          // Se buscar pela credencial OpenAI específica
          if (credId === CRED_OPENAI_ID || provider === "openai") {
            return {
              rows: [
                {
                  api_key_encrypted: Buffer.from("ciphertext-openai"),
                  api_key_iv: Buffer.alloc(12, 1),
                  api_key_tag: Buffer.alloc(16, 2),
                },
              ],
            };
          }

          // Se buscar por anthropic, não existe credencial
          return { rows: [] };
        }

        if (sql.includes("insert into llm_calls")) {
          return { rows: [{ id: "call-1" }] };
        }

        return { rows: [] };
      }),
    };

    // cfg sem nenhuma chave de plataforma no .env
    const cfg = { cacheTtl: "1h" as const };

    const res = await runModelCall(
      pool as never,
      cfg,
      {
        tenantId: ORG_ID,
        purpose: "ai_node",
        llmOverride: undefined, // custom_prompt não passa override de agente
        messages: [{ role: "user", content: "Qual modo você está testando?" }],
      },
      { registry },
    );

    // Asserções:
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.provider).toBe("openai");
    expect(chamadas[0]?.modelId).toBe("gpt-4o");
    expect(res.origem).toBe("binding");
    expect(res.result.text).toBe("CUSTOM PROMPT OK — teste");
  });

  it("CASO 2 — SEM BINDING: fallback da org funciona quando org default possui credencial", async () => {
    const { registry, chamadas } = criarRegistrySpiao();

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("settings->'llm'")) {
          return {
            rows: [
              {
                llm: {
                  provider: "openai",
                  default_model: "gpt-4o-mini",
                  params: {},
                  enabled_models: [],
                },
              },
            ],
          };
        }

        if (sql.includes("from ai_purpose_bindings")) {
          return { rows: [] }; // sem binding para este ponto
        }

        if (sql.includes("from ai_provider_credentials")) {
          return {
            rows: [
              {
                api_key_encrypted: Buffer.from("ciphertext-openai-default"),
                api_key_iv: Buffer.alloc(12, 1),
                api_key_tag: Buffer.alloc(16, 2),
              },
            ],
          };
        }

        if (sql.includes("insert into llm_calls")) {
          return { rows: [{ id: "call-2" }] };
        }

        return { rows: [] };
      }),
    };

    const cfg = { cacheTtl: "1h" as const };

    const res = await runModelCall(
      pool as never,
      cfg,
      {
        tenantId: ORG_ID,
        purpose: "compaction",
        messages: [{ role: "user", content: "resumir" }],
      },
      { registry },
    );

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.provider).toBe("openai");
    expect(chamadas[0]?.modelId).toBe("gpt-4o-mini");
    expect(res.origem).toBe("padrao_da_organizacao");
  });

  it("CASO 3 — EXISTING AGENT: llmOverride explícito do agente permanece intacto", async () => {
    const { registry, chamadas } = criarRegistrySpiao();

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("settings->'llm'")) {
          return {
            rows: [
              {
                llm: {
                  provider: "anthropic",
                  default_model: "claude-sonnet-5",
                },
              },
            ],
          };
        }

        if (sql.includes("from ai_purpose_bindings")) {
          // Mesmo se houver um binding para ai_node, o agente publicado tem precedência
          return {
            rows: [
              {
                purpose: "ai_node",
                provider: "openrouter",
                model_id: "meta-llama/llama-3",
                is_enabled: true,
              },
            ],
          };
        }

        if (sql.includes("from ai_provider_credentials")) {
          return {
            rows: [
              {
                api_key_encrypted: Buffer.from("ciphertext-agent-openai"),
                api_key_iv: Buffer.alloc(12, 1),
                api_key_tag: Buffer.alloc(16, 2),
              },
            ],
          };
        }

        if (sql.includes("insert into llm_calls")) {
          return { rows: [{ id: "call-3" }] };
        }

        return { rows: [] };
      }),
    };

    const cfg = { cacheTtl: "1h" as const };

    const res = await runModelCall(
      pool as never,
      cfg,
      {
        tenantId: ORG_ID,
        purpose: "ai_node",
        model: "gpt-4o",
        llmOverride: {
          provider: "openai",
          credentialId: CRED_OPENAI_ID,
        },
        messages: [{ role: "user", content: "Olá agente" }],
      },
      { registry },
    );

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.provider).toBe("openai");
    expect(chamadas[0]?.modelId).toBe("gpt-4o");
    expect(res.origem).toBe("agente_publicado");
  });

  it("CASO 4 — NENHUMA CREDENCIAL VÁLIDA: continua lançando LlmNotConfiguredError", async () => {
    const { registry } = criarRegistrySpiao();

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("settings->'llm'")) {
          return {
            rows: [
              {
                llm: {
                  provider: "anthropic",
                  default_model: "claude-sonnet-5",
                },
              },
            ],
          };
        }

        if (sql.includes("from ai_purpose_bindings")) {
          return { rows: [] }; // sem binding
        }

        if (sql.includes("from ai_provider_credentials")) {
          return { rows: [] }; // sem credenciais
        }

        return { rows: [] };
      }),
    };

    // Sem chave de plataforma no cfg
    const cfg = { cacheTtl: "1h" as const };

    await expect(
      runModelCall(
        pool as never,
        cfg,
        {
          tenantId: ORG_ID,
          purpose: "ai_node",
          messages: [{ role: "user", content: "teste" }],
        },
        { registry },
      ),
    ).rejects.toThrow(LlmNotConfiguredError);
  });
});

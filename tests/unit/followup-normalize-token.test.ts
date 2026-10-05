import { describe, expect, it } from "vitest";
import { normalizeSharedFlowToken } from "@/lib/followup/sharing/normalize-token";

describe("lib/followup/sharing/normalize-token", () => {
  const VALID_TOKEN = "VV0qTl07-nnmZaDHVU4KQPJf9HsAdHfz";

  it("extrai token de URL https completa", () => {
    const url = `https://zyroncrm.tech/fluxos/compartilhado/${VALID_TOKEN}`;
    expect(normalizeSharedFlowToken(url)).toBe(VALID_TOKEN);
  });

  it("extrai token de URL com porta ou query string", () => {
    const url = `https://app.crm.com:3000/fluxos/compartilhado/${VALID_TOKEN}?utm_source=share`;
    expect(normalizeSharedFlowToken(url)).toBe(VALID_TOKEN);
  });

  it("extrai token de path relativo", () => {
    const path = `/fluxos/compartilhado/${VALID_TOKEN}`;
    expect(normalizeSharedFlowToken(path)).toBe(VALID_TOKEN);
  });

  it("aceita token puro", () => {
    expect(normalizeSharedFlowToken(VALID_TOKEN)).toBe(VALID_TOKEN);
    expect(normalizeSharedFlowToken(`  ${VALID_TOKEN}  `)).toBe(VALID_TOKEN);
  });

  it("rejeita strings vazias ou inválidas", () => {
    expect(normalizeSharedFlowToken("")).toBeNull();
    expect(normalizeSharedFlowToken("   ")).toBeNull();
    expect(normalizeSharedFlowToken("https://zyroncrm.tech/app/ai/followups")).toBeNull();
    expect(normalizeSharedFlowToken("curto")).toBeNull();
    expect(normalizeSharedFlowToken("https://zyroncrm.tech/outro/caminho/1234567890")).toBeNull();
  });
});

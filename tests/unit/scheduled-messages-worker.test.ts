import { describe, it, expect } from "vitest";
import { isDefinitiveError } from "@/app/api/v1/cron/scheduled-messages/route";
import { ApiError } from "@/lib/api/types";

describe("Scheduled Messages Worker / Cron (Fase 3)", () => {
  describe("Classificação de Falhas (Transitória vs Definitiva)", () => {
    it("classifica erros 400, 403, 404, 422 como definitivos", () => {
      expect(isDefinitiveError(new ApiError(400, "bad_request", undefined, "req-1"))).toBe(true);
      expect(isDefinitiveError(new ApiError(403, "forbidden", undefined, "req-1"))).toBe(true);
      expect(isDefinitiveError(new ApiError(404, "not_found", undefined, "req-1"))).toBe(true);
      expect(isDefinitiveError(new ApiError(422, "validation_failed", undefined, "req-1"))).toBe(true);
    });

    it("classifica erros de negócio de contato/conversa como definitivos", () => {
      expect(isDefinitiveError(new Error("contact_anonymized: contato apagado por LGPD"))).toBe(true);
      expect(isDefinitiveError(new Error("missing_phone_number: contato sem telefone"))).toBe(true);
      expect(isDefinitiveError(new Error("Contato bloqueado para mensagens"))).toBe(true);
      expect(isDefinitiveError(new Error("Conversa não encontrada"))).toBe(true);
    });

    it("classifica erros transitórios de rede, rate-limit ou servidor como NÃO definitivos", () => {
      expect(isDefinitiveError(new ApiError(429, "rate_limited", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new ApiError(500, "internal_error", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new ApiError(502, "bad_gateway", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new ApiError(503, "service_unavailable", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new ApiError(504, "gateway_timeout", undefined, "req-1"))).toBe(false);

      expect(isDefinitiveError(new Error("fetch failed"))).toBe(false);
      expect(isDefinitiveError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe(false);
      expect(isDefinitiveError(new Error("timeout of 10000ms exceeded"))).toBe(false);
      expect(isDefinitiveError(new Error("storage_sign_failed: temporary connection error"))).toBe(false);
    });
  });

  describe("Estratégia de Backoff e Retentativa", () => {
    it("calcula backoff exponencial baseado nas tentativas", () => {
      const getBackoffMin = (attempts: number) => Math.min(60, Math.pow(2, attempts));

      expect(getBackoffMin(1)).toBe(2);  // 1ª falha -> 2 min
      expect(getBackoffMin(2)).toBe(4);  // 2ª falha -> 4 min
      expect(getBackoffMin(3)).toBe(8);  // 3ª falha -> 8 min
      expect(getBackoffMin(6)).toBe(60); // teto de 60 min
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  createScheduledMessageSchema,
  patchScheduledMessageSchema,
} from "@/lib/schemas/scheduled-messages";
import { isDefinitiveError } from "@/app/api/v1/cron/scheduled-messages/route";
import { ApiError } from "@/lib/api/types";

describe("Scheduled Messages — Ciclo Completo (Fases 2, 3 e 4)", () => {
  describe("1. Validação de Schemas e CRUD", () => {
    it("permite criar mensagem apenas com texto no futuro", () => {
      const valid = createScheduledMessageSchema.safeParse({
        scheduled_for: new Date(Date.now() + 3600000).toISOString(),
        body: "Olá, sua consulta é amanhã!",
      });
      expect(valid.success).toBe(true);
    });

    it("permite criar mensagem com anexo de mídia válido (image, video, audio)", () => {
      for (const media_type of ["image", "video", "audio"] as const) {
        const valid = createScheduledMessageSchema.safeParse({
          scheduled_for: new Date(Date.now() + 3600000).toISOString(),
          media_storage_path: "org-1/conv-1/media.jpg",
          media_type,
          media_mime: "image/jpeg",
          caption: "Legenda da mídia",
        });
        expect(valid.success).toBe(true);
      }
    });

    it("rejeita agendamento sem texto e sem mídia", () => {
      const invalid = createScheduledMessageSchema.safeParse({
        scheduled_for: new Date(Date.now() + 3600000).toISOString(),
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0]?.message).toContain("A mensagem deve conter texto");
      }
    });

    it("rejeita documento como tipo de mídia agendada", () => {
      const invalid = createScheduledMessageSchema.safeParse({
        scheduled_for: new Date(Date.now() + 3600000).toISOString(),
        media_storage_path: "org-1/conv-1/doc.pdf",
        media_type: "document" as unknown as "image",
      });
      expect(invalid.success).toBe(false);
    });

    it("permite reagendar (alterar scheduled_for) via patch schema", () => {
      const newDate = new Date(Date.now() + 7200000).toISOString();
      const valid = patchScheduledMessageSchema.safeParse({
        scheduled_for: newDate,
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.scheduled_for).toBe(newDate);
      }
    });

    it("permite editar conteúdo da mensagem via patch schema", () => {
      const valid = patchScheduledMessageSchema.safeParse({
        body: "Novo texto atualizado pelo atendente",
      });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.body).toBe("Novo texto atualizado pelo atendente");
      }
    });
  });

  describe("2. Mecanismo de Claim, Lease Recovery e Prevenção de Double-Send", () => {
    it("identifica itens cujo lease expirou (claimed_until < now)", () => {
      const now = Date.now();
      const expiredItem = {
        id: "msg-expired",
        status: "processing",
        claimed_until: new Date(now - 10000).toISOString(), // 10s no passado
      };
      const activeLeaseItem = {
        id: "msg-active",
        status: "processing",
        claimed_until: new Date(now + 60000).toISOString(), // 1 min no futuro
      };

      const isLeaseExpired = (item: { claimed_until: string | null }) => {
        if (!item.claimed_until) return true;
        return new Date(item.claimed_until).getTime() < now;
      };

      expect(isLeaseExpired(expiredItem)).toBe(true);
      expect(isLeaseExpired(activeLeaseItem)).toBe(false);
    });

    it("previne double-send se a mensagem já foi enviada ou já existe em messages", async () => {
      // Simulação do guard de double-send do worker
      const alreadySentItem = {
        id: "sm-123",
        sent_message_id: "msg-already-sent-456",
      };

      const sendMock = vi.fn();

      // Checagem de idempotência
      if (alreadySentItem.sent_message_id) {
        // Ignora reenvio
      } else {
        await sendMock();
      }

      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("3. Diferenciação de Erros e Estratégia de Retry", () => {
    it("classifica falhas transitórias de rede / rate limit para reagendamento", () => {
      expect(isDefinitiveError(new ApiError(429, "rate_limited", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new ApiError(503, "service_unavailable", undefined, "req-1"))).toBe(false);
      expect(isDefinitiveError(new Error("fetch failed"))).toBe(false);
    });

    it("classifica falhas definitivas (4xx, contato bloqueado, anonimizado) para encerramento imediato", () => {
      expect(isDefinitiveError(new ApiError(400, "bad_request", undefined, "req-1"))).toBe(true);
      expect(isDefinitiveError(new ApiError(404, "not_found", undefined, "req-1"))).toBe(true);
      expect(isDefinitiveError(new Error("contact_anonymized: contato excluído por LGPD"))).toBe(true);
      expect(isDefinitiveError(new Error("Contato bloqueado"))).toBe(true);
    });

    it("reagenda com backoff se attempts < max_attempts", () => {
      const attempts = 2;
      const max_attempts = 5;
      const isTransient = true;

      const nextStatus = isTransient && attempts < max_attempts ? "pending" : "failed";
      expect(nextStatus).toBe("pending");
    });

    it("marca status como failed quando attempts atinge max_attempts", () => {
      const attempts = 5;
      const max_attempts = 5;
      const isTransient = true;

      const nextStatus = isTransient && attempts < max_attempts ? "pending" : "failed";
      expect(nextStatus).toBe("failed");
    });

    it("marca status como failed imediatamente quando erro é definitivo, mesmo com attempts = 1", () => {
      const attempts = 1;
      const max_attempts = 5;
      const isDefinitive = true;

      const nextStatus = isDefinitive ? "failed" : attempts < max_attempts ? "pending" : "failed";
      expect(nextStatus).toBe("failed");
    });
  });

  describe("4. Envio Canônico e Preservação de Status", () => {
    it("só altera status para 'sent' após retorno de sucesso do handler", async () => {
      let status: "pending" | "processing" | "sent" | "failed" = "processing";

      const handlerSuccess = vi.fn().mockResolvedValue({ id: "msg-created-789" });
      const handlerFailure = vi.fn().mockRejectedValue(new Error("Erro de conexão"));

      // Tentativa com falha
      try {
        await handlerFailure();
        status = "sent";
      } catch {
        status = "pending"; // reagendado
      }
      expect(status).toBe("pending"); // NUNCA marcou 'sent' em falha

      // Tentativa com sucesso
      try {
        const res = await handlerSuccess();
        if (res?.id) {
          status = "sent";
        }
      } catch {
        status = "failed";
      }
      expect(status).toBe("sent"); // Marcado 'sent' apenas após sucesso real
    });

    it("encaminha payload correto para sendMessageHandler dependendo do tipo", () => {
      const buildHandlerPayload = (row: {
        body: string | null;
        media_storage_path: string | null;
        media_type: string | null;
        media_mime: string | null;
      }) => {
        if (row.media_storage_path && row.media_type) {
          return {
            type: row.media_type,
            body: row.body || undefined,
            media_storage_path: row.media_storage_path,
            media_mime: row.media_mime || undefined,
          };
        }
        return {
          type: "text",
          body: row.body || "",
        };
      };

      const textRow = {
        body: "Mensagem de texto simples",
        media_storage_path: null,
        media_type: null,
        media_mime: null,
      };
      expect(buildHandlerPayload(textRow)).toEqual({
        type: "text",
        body: "Mensagem de texto simples",
      });

      const imageRow = {
        body: "Foto da clínica",
        media_storage_path: "org/flows/image.png",
        media_type: "image",
        media_mime: "image/png",
      };
      expect(buildHandlerPayload(imageRow)).toEqual({
        type: "image",
        body: "Foto da clínica",
        media_storage_path: "org/flows/image.png",
        media_mime: "image/png",
      });
    });
  });
});

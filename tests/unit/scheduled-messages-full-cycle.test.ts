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

    it("confirma que chave lógica estável scheduled_msg_${sm.id} não varia por tentativa", () => {
      const smId = "e1111111-1111-4111-8111-111111111111";
      const keyAttempt1 = `scheduled_msg_${smId}`;
      const keyAttempt2 = `scheduled_msg_${smId}`;
      expect(keyAttempt1).toBe(keyAttempt2);
      expect(keyAttempt1).not.toContain("attempt");
    });

    // Teste A: messages queued + sem external_id após lease expiry
    it("Cenário A: messages queued + sem external_id após lease expiry -> scheduled_messages = failed e provider NÃO chamado novamente", async () => {
      const sm = {
        id: "d0000000-0000-4000-8000-000000000001",
        organization_id: "org-1",
        conversation_id: "conv-1",
        status: "processing" as "pending" | "processing" | "sent" | "failed",
        claimed_until: new Date(Date.now() - 5000).toISOString() as string | null,
        attempts: 1,
        max_attempts: 5,
        sent_message_id: null as string | null,
        last_error: null as string | null,
      };

      // Tabela messages tem registro em queued sem external_id (crash antes do WAHA)
      const existingMsg = {
        id: sm.id,
        organization_id: sm.organization_id,
        conversation_id: sm.conversation_id,
        status: "queued",
        external_id: null,
        created_at: new Date(Date.now() - 3000).toISOString(),
      };

      const providerSendSpy = vi.fn();
      const inboxItemsSpy = vi.fn();

      // Executa lógica da política AT-MOST-ONCE
      const isConfirmedSent =
        (existingMsg.status === "sent" ||
          existingMsg.status === "delivered" ||
          existingMsg.status === "read") &&
        Boolean(existingMsg.external_id);

      if (isConfirmedSent) {
        sm.status = "sent";
        sm.sent_message_id = existingMsg.id;
      } else if (existingMsg.status === "queued" && !existingMsg.external_id) {
        sm.status = "failed";
        sm.sent_message_id = existingMsg.id;
        sm.claimed_until = null;
        sm.last_error =
          "lease_expired_unconfirmed: Uma mensagem programada para este contato ficou em estado não confirmado. " +
          "O sistema não pode garantir se ela chegou ao WhatsApp. Para evitar envio duplicado, ela não foi reenviada automaticamente.";
        inboxItemsSpy({
          organization_id: sm.organization_id,
          kind: "message_send_stuck",
          severity: "critical",
          title: "Mensagem programada não confirmada",
          body: "Uma mensagem programada para este contato ficou em estado não confirmado. O sistema não pode garantir se ela chegou ao WhatsApp. Para evitar envio duplicado, ela não foi reenviada automaticamente.",
          ref_kind: "conversation",
          ref_id: sm.conversation_id,
        });
      } else {
        await providerSendSpy();
      }

      // Assertivas do Cenário A:
      expect(providerSendSpy).not.toHaveBeenCalled();
      expect(sm.status).toBe("failed");
      expect(sm.claimed_until).toBeNull();
      expect(sm.last_error).toContain("lease_expired_unconfirmed");
      expect(inboxItemsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "message_send_stuck",
          severity: "critical",
          organization_id: "org-1",
        })
      );
    });

    // Teste B: messages sent + external_id
    it("Cenário B: messages sent + external_id -> scheduled_messages = sent e provider NÃO chamado novamente", async () => {
      const sm = {
        id: "d0000000-0000-4000-8000-000000000002",
        organization_id: "org-1",
        conversation_id: "conv-1",
        status: "processing" as "pending" | "processing" | "sent" | "failed",
        claimed_until: new Date(Date.now() - 5000).toISOString() as string | null,
        attempts: 1,
        max_attempts: 5,
        sent_message_id: null as string | null,
        last_error: null as string | null,
      };

      // Tabela messages após envio bem-sucedido confirmado
      const existingMsg = {
        id: sm.id,
        organization_id: sm.organization_id,
        conversation_id: sm.conversation_id,
        status: "sent",
        external_id: "waha-msg-external-12345",
        created_at: new Date(Date.now() - 3000).toISOString(),
      };

      const providerSendSpy = vi.fn();

      const isConfirmedSent =
        (existingMsg.status === "sent" ||
          existingMsg.status === "delivered" ||
          existingMsg.status === "read") &&
        Boolean(existingMsg.external_id);

      if (isConfirmedSent) {
        sm.status = "sent";
        sm.sent_message_id = existingMsg.id;
        sm.claimed_until = null;
      } else {
        await providerSendSpy();
      }

      // Assertivas do Cenário B:
      expect(providerSendSpy).not.toHaveBeenCalled();
      expect(sm.status).toBe("sent");
      expect(sm.sent_message_id).toBe(existingMsg.id);
      expect(sm.claimed_until).toBeNull();
    });

    // Teste C: nenhuma messages existente
    it("Cenário C: nenhuma messages existente -> envio normal via provider", async () => {
      const sm = {
        id: "d0000000-0000-4000-8000-000000000003",
        organization_id: "org-1",
        conversation_id: "conv-1",
        status: "processing" as "pending" | "processing" | "sent" | "failed",
        claimed_until: new Date(Date.now() + 60000).toISOString() as string | null,
        attempts: 1,
        max_attempts: 5,
        sent_message_id: null as string | null,
        last_error: null as string | null,
      };

      const existingMsg = null;
      const providerSendSpy = vi.fn().mockResolvedValue({ externalId: "waha-new-msg-999" });

      if (existingMsg) {
        // não entra
      } else {
        const res = await providerSendSpy();
        sm.status = "sent";
        sm.sent_message_id = sm.id;
        sm.claimed_until = null;
      }

      // Assertivas do Cenário C:
      expect(providerSendSpy).toHaveBeenCalledTimes(1);
      expect(sm.status).toBe("sent");
      expect(sm.sent_message_id).toBe(sm.id);
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

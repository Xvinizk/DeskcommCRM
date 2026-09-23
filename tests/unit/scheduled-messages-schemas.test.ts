import { describe, it, expect } from "vitest";
import {
  createScheduledMessageSchema,
  patchScheduledMessageSchema,
  scheduledMessageStatusSchema,
  scheduledMediaTypeSchema,
} from "@/lib/schemas/scheduled-messages";

describe("Scheduled Messages — Schemas e Validação (Fase 2)", () => {
  const futureIso = new Date(Date.now() + 3600_000).toISOString();

  it("aceita criação de mensagem programada de texto", () => {
    const res = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
      body: "Olá, passando para lembrar da nossa reunião!",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.body).toBe("Olá, passando para lembrar da nossa reunião!");
    }
  });

  it("aceita criação de mensagem programada com anexo (imagem, vídeo ou áudio)", () => {
    const imgRes = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
      media_storage_path: "org-1/flows/banner.png",
      media_type: "image",
      media_mime: "image/png",
      media_filename: "banner.png",
      caption: "Confira a foto",
    });
    expect(imgRes.success).toBe(true);

    const vidRes = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
      media_storage_path: "org-1/flows/demo.mp4",
      media_type: "video",
      media_mime: "video/mp4",
      media_filename: "demo.mp4",
    });
    expect(vidRes.success).toBe(true);

    const audRes = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
      media_storage_path: "org-1/flows/audio.ogg",
      media_type: "audio",
      media_mime: "audio/ogg",
      media_filename: "audio.ogg",
    });
    expect(audRes.success).toBe(true);
  });

  it("rejeita criação sem body e sem media_storage_path", () => {
    const res = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
    });
    expect(res.success).toBe(false);
  });

  it("rejeita tipos de mídia fora do escopo (ex: document)", () => {
    const res = createScheduledMessageSchema.safeParse({
      scheduled_for: futureIso,
      media_storage_path: "org-1/flows/doc.pdf",
      media_type: "document" as unknown as "image",
    });
    expect(res.success).toBe(false);
  });

  it("rejeita data inválida em scheduled_for", () => {
    const res = createScheduledMessageSchema.safeParse({
      scheduled_for: "data-invalida",
      body: "Teste",
    });
    expect(res.success).toBe(false);
  });

  it("valida schema de edição e reagendamento (patchScheduledMessageSchema)", () => {
    const patchRes = patchScheduledMessageSchema.safeParse({
      scheduled_for: new Date(Date.now() + 7200_000).toISOString(),
      body: "Texto atualizado",
    });
    expect(patchRes.success).toBe(true);
    if (patchRes.success) {
      expect(patchRes.data.body).toBe("Texto atualizado");
    }
  });

  it("contém todos os status válidos do ciclo de vida", () => {
    const validStatuses = ["pending", "processing", "sent", "cancelled", "failed"];
    for (const status of validStatuses) {
      expect(scheduledMessageStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(scheduledMessageStatusSchema.safeParse("unknown").success).toBe(false);
  });

  it("valida vocabulário de mídia permitido (image, video, audio)", () => {
    expect(scheduledMediaTypeSchema.safeParse("image").success).toBe(true);
    expect(scheduledMediaTypeSchema.safeParse("video").success).toBe(true);
    expect(scheduledMediaTypeSchema.safeParse("audio").success).toBe(true);
    expect(scheduledMediaTypeSchema.safeParse("document").success).toBe(false);
  });
});

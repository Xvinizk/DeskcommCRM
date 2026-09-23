import { describe, it, expect } from "vitest";
import {
  messageImageConfigSchema,
  messageVideoConfigSchema,
  messageAudioConfigSchema,
} from "@/lib/followup/graph-schema";
import {
  validateOutboundMedia,
  isMediaPathOwnedBy,
} from "@/lib/messaging/media/upload-validation";
import { describeNodeConfig } from "@/app/app/ai/followups/[id]/_components/nodes/nodeVisuals";

describe("Flow Builder — Upload de Mídia nos Nós (Fase 1)", () => {
  const orgId = "11111111-1111-1111-1111-111111111111";

  it("permite upload de imagem, vídeo e áudio pela infraestrutura de validação", () => {
    const imgVerdict = validateOutboundMedia("image/png", 1024 * 50);
    expect(imgVerdict.ok).toBe(true);
    if (imgVerdict.ok) expect(imgVerdict.kind).toBe("image");

    const vidVerdict = validateOutboundMedia("video/mp4", 1024 * 1024 * 5);
    expect(vidVerdict.ok).toBe(true);
    if (vidVerdict.ok) expect(vidVerdict.kind).toBe("video");

    const audVerdict = validateOutboundMedia("audio/mpeg", 1024 * 1024 * 2);
    expect(audVerdict.ok).toBe(true);
    if (audVerdict.ok) expect(audVerdict.kind).toBe("audio");
  });

  it("rejeita arquivo com tamanho zero ou acima de 50MB", () => {
    const zeroVerdict = validateOutboundMedia("image/png", 0);
    expect(zeroVerdict.ok).toBe(false);

    const largeVerdict = validateOutboundMedia("image/png", 55 * 1024 * 1024);
    expect(largeVerdict.ok).toBe(false);
    if (!largeVerdict.ok) expect(largeVerdict.code).toBe("payload_too_large");
  });

  it("reconhece posse de mídia no padrão de flows sob a organização", () => {
    const flowPath = `${orgId}/flows/abc-123.jpg`;
    expect(isMediaPathOwnedBy(flowPath, orgId, "qualquer-conversa")).toBe(true);

    const otherOrgPath = `22222222-2222-2222-2222-222222222222/flows/abc-123.jpg`;
    expect(isMediaPathOwnedBy(otherOrgPath, orgId, "qualquer-conversa")).toBe(false);
  });

  it("valida schema de message_image persistindo media_storage_path e metadados", () => {
    const parsed = messageImageConfigSchema.safeParse({
      media_storage_path: `${orgId}/flows/foto.png`,
      media_type: "image",
      media_mime: "image/png",
      media_filename: "foto.png",
      caption: "Legenda opcional",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.media_storage_path).toBe(`${orgId}/flows/foto.png`);
      expect(parsed.data.media_type).toBe("image");
      expect(parsed.data.media_filename).toBe("foto.png");
    }

    const invalid = messageImageConfigSchema.safeParse({
      caption: "Apenas legenda sem mídia",
    });
    expect(invalid.success).toBe(false);
  });

  it("valida schema de message_video persistindo media_storage_path e metadados", () => {
    const parsed = messageVideoConfigSchema.safeParse({
      media_storage_path: `${orgId}/flows/video.mp4`,
      media_type: "video",
      media_mime: "video/mp4",
      media_filename: "apresentacao.mp4",
      caption: "Veja o vídeo",
    });
    expect(parsed.success).toBe(true);
  });

  it("valida schema de message_audio persistindo media_storage_path e metadados", () => {
    const parsed = messageAudioConfigSchema.safeParse({
      media_storage_path: `${orgId}/flows/audio.ogg`,
      media_type: "audio",
      media_mime: "audio/ogg",
      media_filename: "nota_de_voz.ogg",
    });
    expect(parsed.success).toBe(true);
  });

  it("exibe o nome do arquivo no subtítulo visual do nó quando não houver legenda", () => {
    const t = (s: string) => s;
    const descImg = describeNodeConfig(
      "message_image",
      { media_storage_path: `${orgId}/flows/banner.png`, media_filename: "banner.png" },
      t
    );
    expect(descImg).toBe("banner.png");

    const descAud = describeNodeConfig(
      "message_audio",
      { media_storage_path: `${orgId}/flows/audio.ogg`, media_filename: "audio.ogg" },
      t
    );
    expect(descAud).toBe("audio.ogg");
  });
});

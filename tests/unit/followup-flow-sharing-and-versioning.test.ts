import { describe, it, expect } from "vitest";
import { sanitizeFlowForSnapshot } from "@/lib/followup/sharing/sanitize";
import { flowExportJsonSchema } from "@/lib/followup/sharing/json-schema";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { MIME_EXT } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";

describe("Fluxo — Compartilhamento, Versionamento e Importação", () => {
  const sampleGraph: FlowGraph = {
    nodes: [
      {
        id: "node_trigger",
        type: "trigger",
        label: "Gatilho de Início",
        position: { x: 0, y: 0 },
        config: { type: "manual" },
      },
      {
        id: "node_text_1",
        type: "message_text",
        label: "Texto de Boas-vindas",
        position: { x: 100, y: 100 },
        config: { body: "Olá, seja bem-vindo ao nosso fluxo!" },
      },
      {
        id: "node_img_1",
        type: "message_image",
        label: "Banner Promocional",
        position: { x: 200, y: 200 },
        config: {
          media_storage_path: "org-123/flows/imagem1.png",
          media_type: "image",
          media_mime: "image/png",
          media_filename: "imagem1.png",
          media_size_bytes: 1024 * 50,
          caption: "Foto promocional",
        },
      },
      {
        id: "node_vid_1",
        type: "message_video",
        label: "Vídeo Apresentação",
        position: { x: 300, y: 300 },
        config: {
          media_storage_path: "org-123/flows/video1.mp4",
          media_type: "video",
          media_mime: "video/mp4",
          media_filename: "video-newborn.mp4",
          media_size_bytes: 1024 * 1024 * 18,
          caption: "Apresentação",
        },
      },
      {
        id: "node_aud_1",
        type: "message_audio",
        label: "Áudio Explicativo",
        position: { x: 400, y: 400 },
        config: {
          media_storage_path: "org-123/flows/audio1.ogg",
          media_type: "audio",
          media_mime: "audio/ogg",
          media_filename: "audio-explicativo.ogg",
          media_size_bytes: 1024 * 500,
        },
      },
      {
        id: "node_typing_1",
        type: "typing",
        label: "Digitando...",
        position: { x: 500, y: 500 },
        config: { duration_seconds: 3 },
      },
      {
        id: "node_delay_1",
        type: "delay",
        label: "Aguardar 5min",
        position: { x: 600, y: 600 },
        config: { duration_value: 5, unit: "minutes" },
      },
      {
        id: "node_tag_1",
        type: "tag",
        label: "Adicionar Tag",
        position: { x: 700, y: 700 },
        config: { action: "add", tags: ["Interessado"] },
      },
      {
        id: "node_stage_1",
        type: "stage_move",
        label: "Mover Etapa",
        position: { x: 800, y: 800 },
        config: {
          pipeline_id: "11111111-1111-4111-8111-111111111111",
          stage_id: "22222222-2222-4222-8222-222222222222",
        },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "node_trigger",
        target: "node_text_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e2",
        source: "node_text_1",
        target: "node_img_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e3",
        source: "node_img_1",
        target: "node_vid_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e4",
        source: "node_vid_1",
        target: "node_aud_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e5",
        source: "node_aud_1",
        target: "node_typing_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e6",
        source: "node_typing_1",
        target: "node_delay_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e7",
        source: "node_delay_1",
        target: "node_tag_1",
        priority: 0,
        condition: { type: "always" },
      },
      {
        id: "e8",
        source: "node_tag_1",
        target: "node_stage_1",
        priority: 0,
        condition: { type: "always" },
      },
    ],
  };

  it("higieniza snapshot removendo dados sensíveis da organização original e contando mídias", () => {
    const snapshot = sanitizeFlowForSnapshot({
      name: "Funil Newborn",
      graph: sampleGraph,
    });

    expect(snapshot.node_count).toBe(9);
    expect(snapshot.image_count).toBe(1);
    expect(snapshot.video_count).toBe(1);
    expect(snapshot.audio_count).toBe(1);

    // Converte para string e verifica que não há credenciais, tokens, ou campos sensíveis
    const jsonStr = JSON.stringify(snapshot);
    expect(jsonStr).not.toContain("service_role");
    expect(jsonStr).not.toContain("secret");
    expect(jsonStr).not.toContain("authorization");

    // Preserva nós e posições
    expect(snapshot.graph.nodes).toHaveLength(9);
    expect(snapshot.graph.edges).toHaveLength(8);

    const videoNode = snapshot.graph.nodes.find((n) => n.id === "node_vid_1");
    expect(videoNode?.config).toMatchObject({
      media_type: "video",
      media_mime: "video/mp4",
      media_filename: "video-newborn.mp4",
    });
  });

  it("valida schema de exportação/importação JSON com schema_version = 1", () => {
    const exportPayload = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      flow: {
        name: "Funil Newborn",
        handoff_policy: "pause",
        trigger_config: { type: "silence", delay_seconds: 3600 },
      },
      nodes: sampleGraph.nodes,
      edges: sampleGraph.edges,
      media: [
        {
          node_id: "node_vid_1",
          media_type: "video",
          media_mime: "video/mp4",
          media_filename: "video-newborn.mp4",
          media_storage_path: "org-123/flows/video1.mp4",
          media_size_bytes: 1024 * 1024 * 18,
        },
      ],
    };

    const parsed = flowExportJsonSchema.safeParse(exportPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flow.name).toBe("Funil Newborn");
      expect(parsed.data.nodes).toHaveLength(9);
      expect(parsed.data.edges).toHaveLength(8);
      expect(parsed.data.media).toHaveLength(1);
    }
  });

  it("rejeita schema JSON com schema_version não suportado", () => {
    const invalidPayload = {
      schema_version: 99,
      flow: { name: "Teste" },
      nodes: [],
      edges: [],
    };

    const parsed = flowExportJsonSchema.safeParse(invalidPayload);
    expect(parsed.success).toBe(false);
  });

  it("suporta tipos de vídeo MP4, MOV e WEBM no mapa de extensões e validação", () => {
    expect(MIME_EXT["video/mp4"]).toBe("mp4");
    expect(MIME_EXT["video/quicktime"]).toBe("mov");
    expect(MIME_EXT["video/webm"]).toBe("webm");

    const mp4Verdict = validateOutboundMedia("video/mp4", 1024 * 1024 * 10);
    expect(mp4Verdict.ok).toBe(true);

    const movVerdict = validateOutboundMedia("video/quicktime", 1024 * 1024 * 15);
    expect(movVerdict.ok).toBe(true);

    const webmVerdict = validateOutboundMedia("video/webm", 1024 * 1024 * 5);
    expect(webmVerdict.ok).toBe(true);
  });
});

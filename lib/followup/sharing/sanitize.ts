import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/followup/graph-schema";

export interface SanitizedMediaItem {
  node_id: string;
  media_type: "image" | "video" | "audio";
  media_mime?: string;
  media_filename?: string;
  media_storage_path?: string;
  media_url?: string;
  media_size_bytes?: number;
}

export interface SharedFlowSnapshot {
  flow_name: string;
  handoff_policy: "pause" | "cancel" | "allow";
  trigger_config: Record<string, unknown>;
  graph: FlowGraph;
  media: SanitizedMediaItem[];
  node_count: number;
  image_count: number;
  video_count: number;
  audio_count: number;
  created_at: string;
}

/**
 * Sanitiza um fluxo para snapshot compartilhado ou exportação JSON.
 * Remove dados da organização de origem, contatos, conversas e segredos.
 */
export function sanitizeFlowForSnapshot(params: {
  name: string;
  handoff_policy?: "pause" | "cancel" | "allow";
  trigger_config?: Record<string, unknown>;
  graph: FlowGraph;
}): SharedFlowSnapshot {
  const { name, handoff_policy = "pause", trigger_config = { kind: "manual" }, graph } = params;

  const mediaList: SanitizedMediaItem[] = [];
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;

  const sanitizedNodes: FlowNode[] = (graph.nodes ?? []).map((node) => {
    const cleanNode = {
      id: node.id,
      type: node.type,
      label: node.label,
      position: { x: node.position.x, y: node.position.y },
      config: { ...(node.config as Record<string, unknown>) },
    } as unknown as FlowNode;

    const nodeCfg = cleanNode.config as Record<string, unknown>;
    delete nodeCfg.organization_id;
    delete nodeCfg.contact_id;
    delete nodeCfg.conversation_id;

    if (node.type === "stage_move") {
      nodeCfg.stage_name = nodeCfg.stage_name || node.label;
      delete nodeCfg.pipeline_id;
      delete nodeCfg.stage_id;
    }

    // Detectar mídias para acompanhamento no snapshot
    if (node.type === "message_image") {
      imageCount++;
      const cfg = node.config as Record<string, unknown>;
      mediaList.push({
        node_id: node.id,
        media_type: "image",
        media_mime: cfg.media_mime as string | undefined,
        media_filename: cfg.media_filename as string | undefined,
        media_storage_path: cfg.media_storage_path as string | undefined,
        media_url: cfg.media_url as string | undefined,
        media_size_bytes: cfg.media_size_bytes as number | undefined,
      });
    } else if (node.type === "message_video") {
      videoCount++;
      const cfg = node.config as Record<string, unknown>;
      mediaList.push({
        node_id: node.id,
        media_type: "video",
        media_mime: cfg.media_mime as string | undefined,
        media_filename: cfg.media_filename as string | undefined,
        media_storage_path: cfg.media_storage_path as string | undefined,
        media_url: cfg.media_url as string | undefined,
        media_size_bytes: cfg.media_size_bytes as number | undefined,
      });
    } else if (node.type === "message_audio") {
      audioCount++;
      const cfg = node.config as Record<string, unknown>;
      mediaList.push({
        node_id: node.id,
        media_type: "audio",
        media_mime: cfg.media_mime as string | undefined,
        media_filename: cfg.media_filename as string | undefined,
        media_storage_path: cfg.media_storage_path as string | undefined,
        media_url: cfg.media_url as string | undefined,
        media_size_bytes: cfg.media_size_bytes as number | undefined,
      });
    }

    return cleanNode;
  });

  const sanitizedEdges: FlowEdge[] = (graph.edges ?? []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    priority: edge.priority ?? 0,
    condition: edge.condition,
  }));

  // Sanitizar trigger_config de possíveis IDs internos
  const cleanTrigger: Record<string, unknown> = { ...(trigger_config ?? {}) };
  delete cleanTrigger.organization_id;
  delete cleanTrigger.contact_id;
  delete cleanTrigger.conversation_id;

  return {
    flow_name: name,
    handoff_policy,
    trigger_config: cleanTrigger,
    graph: {
      nodes: sanitizedNodes,
      edges: sanitizedEdges,
    },
    media: mediaList,
    node_count: sanitizedNodes.length,
    image_count: imageCount,
    video_count: videoCount,
    audio_count: audioCount,
    created_at: new Date().toISOString(),
  };
}

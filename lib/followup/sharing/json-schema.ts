import { z } from "zod";
import { flowNodeSchema, flowEdgeSchema } from "@/lib/followup/graph-schema";

export const flowJsonMediaItemSchema = z.object({
  node_id: z.string(),
  media_type: z.enum(["image", "video", "audio"]),
  media_mime: z.string().optional(),
  media_filename: z.string().optional(),
  media_storage_path: z.string().optional(),
  media_url: z.string().optional(),
  media_size_bytes: z.number().int().nonnegative().optional(),
});

export const flowExportJsonSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal("1")]).default(1),
  exported_at: z.string().optional().default(() => new Date().toISOString()),
  flow: z.object({
    name: z.string().min(1).max(255),
    handoff_policy: z.enum(["pause", "cancel", "allow"]).default("pause"),
    trigger_config: z.record(z.string(), z.unknown()).optional(),
  }),
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
  media: z.array(flowJsonMediaItemSchema).default([]),
});

export type FlowExportJson = z.infer<typeof flowExportJsonSchema>;

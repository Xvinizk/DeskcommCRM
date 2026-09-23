import { z } from "zod";

export const scheduledMessageStatusSchema = z.enum([
  "pending",
  "processing",
  "sent",
  "cancelled",
  "failed",
]);

export const scheduledMediaTypeSchema = z.enum(["image", "video", "audio"]);

export const createScheduledMessageSchema = z
  .strictObject({
    scheduled_for: z
      .string()
      .datetime({ message: "scheduled_for deve ser uma data ISO-8601 válida." }),
    body: z.string().min(1).max(4000).optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_type: scheduledMediaTypeSchema.optional(),
    media_mime: z.string().max(100).optional(),
    media_filename: z.string().max(255).optional(),
    caption: z.string().max(1000).optional(),
  })
  .refine(
    (data) => Boolean(data.body?.trim() || data.media_storage_path),
    {
      message: "A mensagem deve conter texto ('body') ou anexo ('media_storage_path').",
      path: ["body"],
    }
  );

export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;

export const patchScheduledMessageSchema = z
  .strictObject({
    scheduled_for: z
      .string()
      .datetime({ message: "scheduled_for deve ser uma data ISO-8601 válida." })
      .optional(),
    body: z.string().min(1).max(4000).nullable().optional(),
    media_storage_path: z.string().min(1).max(500).nullable().optional(),
    media_type: scheduledMediaTypeSchema.nullable().optional(),
    media_mime: z.string().max(100).nullable().optional(),
    media_filename: z.string().max(255).nullable().optional(),
    caption: z.string().max(1000).nullable().optional(),
  });

export type PatchScheduledMessageInput = z.infer<typeof patchScheduledMessageSchema>;

export interface ScheduledMessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  created_by: string | null;
  status: "pending" | "processing" | "sent" | "cancelled" | "failed";
  scheduled_for: string;
  body: string | null;
  media_storage_path: string | null;
  media_type: "image" | "video" | "audio" | null;
  media_mime: string | null;
  media_filename: string | null;
  caption: string | null;
  attempts: number;
  max_attempts: number;
  claimed_until: string | null;
  last_error: string | null;
  sent_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

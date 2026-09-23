"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  messageImageConfigSchema,
  messageVideoConfigSchema,
  messageAudioConfigSchema,
} from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

interface Props {
  type: "message_image" | "message_video" | "message_audio";
  config:
    | ConfigOf<"message_image">
    | ConfigOf<"message_video">
    | ConfigOf<"message_audio">;
  onChange: (
    c:
      | ConfigOf<"message_image">
      | ConfigOf<"message_video">
      | ConfigOf<"message_audio">
  ) => void;
}

export function MessageMediaForm({ type, config, onChange }: Props) {
  const t = useT();
  const [mediaUrl, setMediaUrl] = useState(config.media_url ?? "");
  const [caption, setCaption] = useState(
    type !== "message_audio" ? (config as ConfigOf<"message_image">).caption ?? "" : ""
  );
  const [error, setError] = useState<string | null>(null);

  const commit = (nextUrl: string, nextCaption: string) => {
    setMediaUrl(nextUrl);
    setCaption(nextCaption);

    let parsed;
    if (type === "message_image") {
      parsed = messageImageConfigSchema.safeParse({
        media_url: nextUrl,
        ...(nextCaption.trim() ? { caption: nextCaption } : {}),
      });
    } else if (type === "message_video") {
      parsed = messageVideoConfigSchema.safeParse({
        media_url: nextUrl,
        ...(nextCaption.trim() ? { caption: nextCaption } : {}),
      });
    } else {
      parsed = messageAudioConfigSchema.safeParse({
        media_url: nextUrl,
      });
    }

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("URL de mídia inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const labelMidia =
    type === "message_image"
      ? t("URL da Imagem")
      : type === "message_video"
        ? t("URL do Vídeo")
        : t("URL do Áudio");

  const placeholderMidia =
    type === "message_image"
      ? "https://.../imagem.jpg"
      : type === "message_video"
        ? "https://.../video.mp4"
        : "https://.../audio.mp3";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="media-url">{labelMidia}</Label>
        <Input
          id="media-url"
          type="url"
          value={mediaUrl}
          placeholder={placeholderMidia}
          onChange={(e) => commit(e.target.value, caption)}
        />
        {error && <p className="text-xs text-error-fg">{error}</p>}
      </div>

      {type !== "message_audio" && (
        <div className="space-y-1.5">
          <Label htmlFor="media-caption">{t("Legenda (opcional)")}</Label>
          <Textarea
            id="media-caption"
            value={caption}
            rows={3}
            maxLength={1000}
            placeholder={t("Texto de legenda que acompanha a mídia...")}
            onChange={(e) => commit(mediaUrl, e.target.value)}
          />
        </div>
      )}

      {mediaUrl.startsWith("http") && type === "message_image" && (
        <div className="overflow-hidden rounded-md border border-border bg-surface-raised p-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl}
            alt={t("Pré-visualização")}
            className="max-h-40 w-full object-contain"
            onError={() => setError(t("Não foi possível carregar a imagem na URL fornecida."))}
          />
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useRef, type ChangeEvent, type DragEvent } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  messageImageConfigSchema,
  messageVideoConfigSchema,
  messageAudioConfigSchema,
} from "@/lib/followup/graph-schema";
import {
  UploadSimple,
  Trash,
  ArrowsClockwise,
  ImageIcon,
  VideoCamera,
  MusicNote,
  CircleNotch,
} from "@/lib/ui/icons";
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

const MAX_BYTES = 50 * 1024 * 1024; // 50MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageMediaForm({ type, config, onChange }: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mediaStoragePath, setMediaStoragePath] = useState(config.media_storage_path ?? "");
  const [mediaUrl, setMediaUrl] = useState(config.media_url ?? "");
  const [mediaType, setMediaType] = useState(
    config.media_type ?? (type === "message_image" ? "image" : type === "message_video" ? "video" : "audio")
  );
  const [mediaMime, setMediaMime] = useState(config.media_mime ?? "");
  const [mediaFilename, setMediaFilename] = useState(config.media_filename ?? "");
  const [mediaSizeBytes, setMediaSizeBytes] = useState<number | null>(
    (config as Record<string, unknown>).media_size_bytes as number | null ?? null
  );
  const [caption, setCaption] = useState(
    type !== "message_audio" ? (config as ConfigOf<"message_image">).caption ?? "" : ""
  );

  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = (
    nextStoragePath: string,
    nextUrl: string,
    nextType: "image" | "video" | "audio",
    nextMime: string,
    nextFilename: string,
    nextCaption: string,
    nextSizeBytes?: number | null
  ) => {
    setMediaStoragePath(nextStoragePath);
    setMediaUrl(nextUrl);
    setMediaType(nextType);
    setMediaMime(nextMime);
    setMediaFilename(nextFilename);
    setCaption(nextCaption);
    const sizeToSave = nextSizeBytes !== undefined ? nextSizeBytes : mediaSizeBytes;
    setMediaSizeBytes(sizeToSave);

    const basePayload = {
      ...(nextStoragePath ? { media_storage_path: nextStoragePath } : {}),
      ...(nextUrl ? { media_url: nextUrl } : {}),
      ...(nextType ? { media_type: nextType } : {}),
      ...(nextMime ? { media_mime: nextMime } : {}),
      ...(nextFilename ? { media_filename: nextFilename } : {}),
      ...(sizeToSave ? { media_size_bytes: sizeToSave } : {}),
    };

    let parsed;
    if (type === "message_image") {
      parsed = messageImageConfigSchema.safeParse({
        ...basePayload,
        media_type: "image",
        ...(nextCaption.trim() ? { caption: nextCaption } : {}),
      });
    } else if (type === "message_video") {
      parsed = messageVideoConfigSchema.safeParse({
        ...basePayload,
        media_type: "video",
        ...(nextCaption.trim() ? { caption: nextCaption } : {}),
      });
    } else {
      parsed = messageAudioConfigSchema.safeParse({
        ...basePayload,
        media_type: "audio",
      });
    }

    if (!parsed.success) {
      const issueMsg = parsed.error.issues[0]?.message;
      if (issueMsg?.includes("media_storage_path or media_url is required")) {
        setError(
          type === "message_video"
            ? t("Selecione um vídeo.")
            : type === "message_image"
              ? t("Selecione uma imagem.")
              : t("Selecione um áudio.")
        );
      } else {
        setError(issueMsg ?? t("Arquivo de mídia obrigatório."));
      }
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const uploadFile = async (file: File) => {
    setError(null);

    // Validação básica client-side
    if (file.size > MAX_BYTES) {
      setError(t("O arquivo excede o limite de 50MB."));
      return;
    }

    let mime = file.type || "";
    if (!mime || mime === "application/octet-stream") {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "mp4") mime = "video/mp4";
      else if (ext === "mov") mime = "video/quicktime";
      else if (ext === "webm") mime = "video/webm";
      else if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
      else if (ext === "png") mime = "image/png";
      else if (ext === "webp") mime = "image/webp";
      else if (ext === "gif") mime = "image/gif";
      else if (ext === "mp3") mime = "audio/mpeg";
      else if (ext === "ogg") mime = "audio/ogg";
      else if (ext === "wav") mime = "audio/wav";
      else mime = "application/octet-stream";
    }

    if (type === "message_image" && !mime.startsWith("image/")) {
      setError(t("Por favor, selecione uma imagem válida."));
      return;
    }
    if (type === "message_video" && !mime.startsWith("video/")) {
      setError(t("Por favor, selecione um vídeo válido."));
      return;
    }
    if (type === "message_audio" && !mime.startsWith("audio/")) {
      setError(t("Por favor, selecione um arquivo de áudio válido."));
      return;
    }

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/v1/ai/followup-flows/media", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.data?.storage_path) {
        const rawMsg = json.error?.message;
        if (rawMsg && rawMsg.includes("Campo 'file' (multipart) obrigatório")) {
          setError(
            type === "message_video"
              ? t("Selecione um vídeo.")
              : type === "message_image"
                ? t("Selecione uma imagem.")
                : t("Selecione um áudio.")
          );
        } else {
          setError(rawMsg || t("Erro ao fazer upload da mídia."));
        }
        return;
      }

      const uploaded = json.data as {
        storage_path: string;
        media_type: "image" | "video" | "audio";
        media_mime: string;
        media_filename: string;
        media_size_bytes?: number;
      };

      commit(
        uploaded.storage_path,
        "", // substitui qualquer url antiga pelo storage_path
        uploaded.media_type,
        uploaded.media_mime,
        uploaded.media_filename,
        caption,
        uploaded.media_size_bytes ?? file.size
      );
    } catch {
      setError(t("Falha de conexão ao enviar o arquivo."));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void uploadFile(file);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      void uploadFile(file);
    }
  };

  const handleRemove = () => {
    setMediaStoragePath("");
    setMediaUrl("");
    setMediaFilename("");
    setMediaMime("");
    setMediaSizeBytes(null);
    setError(null);
    onChange({
      media_storage_path: "",
      media_url: "",
      media_filename: "",
      media_mime: "",
      caption: type !== "message_audio" ? caption : undefined,
    } as unknown as ConfigOf<"message_image">);
  };

  const acceptedTypes =
    type === "message_image"
      ? "image/jpeg,image/png,image/webp,image/gif"
      : type === "message_video"
        ? "video/mp4,video/quicktime,video/webm"
        : "audio/mpeg,audio/ogg,audio/wav,audio/mp4,audio/aac,audio/webm";

  const typeIcon =
    type === "message_image" ? (
      <ImageIcon className="h-6 w-6 text-muted-fg" />
    ) : type === "message_video" ? (
      <VideoCamera className="h-6 w-6 text-muted-fg" />
    ) : (
      <MusicNote className="h-6 w-6 text-muted-fg" />
    );

  const previewSource = mediaStoragePath
    ? `/api/v1/ai/followup-flows/media?path=${encodeURIComponent(mediaStoragePath)}`
    : mediaUrl || "";

  const hasMedia = Boolean(mediaStoragePath || mediaUrl);

  return (
    <div className="space-y-4">
      <input
        type="file"
        ref={fileInputRef}
        accept={acceptedTypes}
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="space-y-1.5">
        <Label>
          {type === "message_image"
            ? t("Imagem da Mensagem")
            : type === "message_video"
              ? t("Vídeo da Mensagem")
              : t("Áudio da Mensagem")}
        </Label>

        {!hasMedia ? (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !isUploading && fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-fg/50 bg-surface-raised/40"
            } ${isUploading ? "pointer-events-none opacity-60" : ""}`}
          >
            {isUploading ? (
              <div className="flex flex-col items-center gap-2">
                <CircleNotch className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm font-medium">{t("Enviando arquivo...")}</p>
                <p className="text-xs text-muted-fg">{t("Aguarde o processamento.")}</p>
              </div>
            ) : (
              <>
                <div className="rounded-full bg-surface p-3 shadow-sm">{typeIcon}</div>
                <div>
                  <p className="text-sm font-medium">
                    {t("Clique para selecionar")} {t("ou arraste o arquivo aqui")}
                  </p>
                  <p className="text-xs text-muted-fg mt-0.5">
                    {type === "message_image"
                      ? t("PNG, JPG, WEBP até 50MB")
                      : type === "message_video"
                        ? t("MP4, MOV até 50MB")
                        : t("MP3, OGG, WAV até 50MB")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 gap-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  <UploadSimple className="h-4 w-4" />
                  {type === "message_image"
                    ? t("Enviar imagem")
                    : type === "message_video"
                      ? t("Enviar vídeo")
                      : t("Enviar áudio")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-surface-raised p-3 space-y-3">
            {/* Visualização de Prévia */}
            {type === "message_image" && (
              <div className="relative flex max-h-48 items-center justify-center overflow-hidden rounded-md bg-black/5 p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewSource}
                  alt={mediaFilename || t("Pré-visualização")}
                  className="max-h-44 w-auto object-contain rounded-md"
                  onError={() => setError(t("Não foi possível carregar a imagem."))}
                />
              </div>
            )}

            {type === "message_video" && (
              <div className="overflow-hidden rounded-md bg-black">
                <video
                  src={previewSource}
                  controls
                  className="max-h-48 w-full object-contain"
                  onError={() => setError(t("Não foi possível carregar o vídeo."))}
                />
              </div>
            )}

            {type === "message_audio" && (
              <div className="rounded-md bg-surface p-2 border border-border">
                <audio
                  src={previewSource}
                  controls
                  className="w-full"
                  onError={() => setError(t("Não foi possível reproduzir o áudio."))}
                />
              </div>
            )}

            {/* Informações do arquivo */}
            <div className="flex flex-col gap-1.5 px-1 py-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate max-w-[200px] font-medium text-text" title={mediaFilename || mediaStoragePath}>
                  {mediaFilename || (mediaStoragePath ? mediaStoragePath.split("/").pop() : t("Arquivo anexado"))}
                </span>
                {mediaSizeBytes ? (
                  <span className="font-mono text-xs text-text-muted">{formatBytes(mediaSizeBytes)}</span>
                ) : null}
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-success-fg">
                  ✓ {type === "message_video" ? t("Vídeo enviado") : type === "message_image" ? t("Imagem enviada") : t("Áudio enviado")}
                </span>
                {mediaMime && (
                  <span className="font-mono text-[10px] uppercase text-text-muted">{mediaMime.split("/")[1] || mediaMime}</span>
                )}
              </div>
            </div>

            {/* Ações: Trocar e Remover */}
            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1 gap-1.5"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {isUploading ? (
                  <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowsClockwise className="h-3.5 w-3.5" />
                )}
                {t("Trocar arquivo")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-error-fg hover:text-error-fg hover:bg-error-bg/10 gap-1.5"
                disabled={isUploading}
                onClick={handleRemove}
              >
                <Trash className="h-3.5 w-3.5" />
                {t("Remover")}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-error-fg mt-1.5">{error}</p>}
      </div>

      {type !== "message_audio" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="media-caption">{t("Legenda (opcional)")}</Label>
            <span className="text-xs text-muted-fg">{caption.length}/1000</span>
          </div>
          <Textarea
            id="media-caption"
            value={caption}
            rows={3}
            maxLength={1000}
            placeholder={t("Texto de legenda que acompanha a mídia...")}
            onChange={(e) =>
              commit(mediaStoragePath, mediaUrl, mediaType, mediaMime, mediaFilename, e.target.value)
            }
          />
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Clock, Trash, Plus, ImageSquare } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";
import { useUploadMedia } from "@/hooks/inbox/useUploadMedia";
import {
  useCreateScheduledMessage,
  useUpdateScheduledMessage,
} from "@/hooks/inbox/useScheduledMessages";
import type { ScheduledMessageRow } from "@/lib/schemas/scheduled-messages";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  initialDraft?: string;
  editingMessage?: ScheduledMessageRow | null;
  onSuccess?: () => void;
}

function getDefaultDateTime(): { date: string; time: string } {
  const d = new Date(Date.now() + 60 * 60 * 1000); // 1 hora no futuro por padrão
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` };
}

function parseIsoToLocal(isoString: string): { date: string; time: string } {
  const d = new Date(isoString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` };
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  conversationId,
  initialDraft = "",
  editingMessage,
  onSuccess,
}: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [existingMedia, setExistingMedia] = useState<{
    path: string;
    type: "image" | "video" | "audio";
    mime: string | null;
    filename: string | null;
  } | null>(null);

  const [validationError, setValidationError] = useState<string | null>(null);

  const upload = useUploadMedia();
  const createScheduled = useCreateScheduledMessage();
  const updateScheduled = useUpdateScheduledMessage();

  // Reset or initialize state when dialog opens
  useEffect(() => {
    if (!open) return;
    setValidationError(null);
    setPendingFile(null);

    if (editingMessage) {
      const parsed = parseIsoToLocal(editingMessage.scheduled_for);
      setDate(parsed.date);
      setTime(parsed.time);
      setText(editingMessage.body || editingMessage.caption || "");
      if (editingMessage.media_storage_path && editingMessage.media_type) {
        setExistingMedia({
          path: editingMessage.media_storage_path,
          type: editingMessage.media_type,
          mime: editingMessage.media_mime,
          filename: editingMessage.media_filename,
        });
      } else {
        setExistingMedia(null);
      }
    } else {
      const defaults = getDefaultDateTime();
      setDate(defaults.date);
      setTime(defaults.time);
      setText(initialDraft);
      setExistingMedia(null);
    }
  }, [open, editingMessage, initialDraft]);

  const objectUrl = useMemo(() => {
    if (pendingFile && /^(image|video|audio)\//.test(pendingFile.type)) {
      return URL.createObjectURL(pendingFile);
    }
    return null;
  }, [pendingFile]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const minDate = useMemo(() => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
        setValidationError(t("Apenas fotos, vídeos e áudios são suportados nesta versão."));
        return;
      }
      setPendingFile(file);
      setExistingMedia(null);
      setValidationError(null);
    }
    e.target.value = "";
  };

  const handleRemoveMedia = () => {
    setPendingFile(null);
    setExistingMedia(null);
  };

  const isSubmitting = upload.isPending || createScheduled.isPending || updateScheduled.isPending;

  const handleSubmit = async () => {
    setValidationError(null);

    if (!date || !time) {
      setValidationError(t("Informe a data e a hora do agendamento."));
      return;
    }

    const scheduledDate = new Date(`${date}T${time}:00`);
    if (isNaN(scheduledDate.getTime())) {
      setValidationError(t("Data ou hora inválida."));
      return;
    }

    if (scheduledDate.getTime() <= Date.now() + 30_000) {
      setValidationError(t("A data e hora de agendamento deve ser pelo menos 1 minuto no futuro."));
      return;
    }

    const hasMedia = Boolean(pendingFile || existingMedia);
    const bodyText = text.trim();

    if (!bodyText && !hasMedia) {
      setValidationError(t("Digite uma mensagem ou anexe uma foto, vídeo ou áudio."));
      return;
    }

    try {
      let mediaPath = existingMedia?.path;
      let mediaType = existingMedia?.type;
      let mediaMime = existingMedia?.mime ?? undefined;
      let mediaFilename = existingMedia?.filename ?? undefined;

      if (pendingFile) {
        const uploaded = await upload.mutateAsync({
          conversationId,
          file: pendingFile,
          filename: pendingFile.name,
        });

        if (uploaded.kind === "document") {
          setValidationError(t("Envio de documento não suportado para agendamento."));
          return;
        }

        mediaPath = uploaded.storage_path;
        mediaType = uploaded.kind;
        mediaMime = uploaded.media_mime;
        mediaFilename = pendingFile.name;
      }

      const isoDate = scheduledDate.toISOString();

      if (editingMessage) {
        await updateScheduled.mutateAsync({
          conversationId,
          messageId: editingMessage.id,
          data: {
            scheduled_for: isoDate,
            body: bodyText || null,
            media_storage_path: mediaPath ?? null,
            media_type: mediaType ?? null,
            media_mime: mediaMime ?? null,
            media_filename: mediaFilename ?? null,
            caption: hasMedia ? bodyText || null : null,
          },
        });
        toast.success(t("Mensagem reprogramada com sucesso."));
      } else {
        await createScheduled.mutateAsync({
          conversationId,
          data: {
            scheduled_for: isoDate,
            body: bodyText || undefined,
            media_storage_path: mediaPath,
            media_type: mediaType,
            media_mime: mediaMime,
            media_filename: mediaFilename,
            caption: hasMedia ? bodyText || undefined : undefined,
          },
        });
        toast.success(t("Mensagem programada com sucesso."));
      }

      onOpenChange(false);
      onSuccess?.();
    } catch {
      // Erro exibido pelo onError do useUploadMedia / useCreateScheduledMessage
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock size={20} className="text-primary" />
            {editingMessage ? t("Editar mensagem programada") : t("Programar mensagem")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Data e Hora */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-date" className="text-xs font-medium">
                {t("Data")}
              </Label>
              <Input
                id="schedule-date"
                type="date"
                min={minDate}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={isSubmitting}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-time" className="text-xs font-medium">
                {t("Hora")}
              </Label>
              <Input
                id="schedule-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={isSubmitting}
                className="text-sm"
              />
            </div>
          </div>

          {/* Texto da mensagem */}
          <div className="space-y-1.5">
            <Label htmlFor="schedule-body" className="text-xs font-medium">
              {pendingFile || existingMedia ? t("Legenda / Texto") : t("Mensagem")}
            </Label>
            <Textarea
              id="schedule-body"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                pendingFile || existingMedia
                  ? t("Legenda opcional para a mídia…")
                  : t("Digite o conteúdo da mensagem programada…")
              }
              rows={3}
              disabled={isSubmitting}
              className="resize-none text-sm"
            />
          </div>

          {/* Seção de Mídia */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">{t("Mídia (opcional)")}</Label>

            {pendingFile && (
              <div className="relative rounded-lg border border-border bg-muted/30 p-2.5">
                {pendingFile.type.startsWith("image/") && objectUrl && (
                  <div className="flex justify-center mb-2">
                    <img
                      src={objectUrl}
                      alt={pendingFile.name}
                      className="max-h-40 rounded-md object-contain"
                    />
                  </div>
                )}
                {pendingFile.type.startsWith("video/") && objectUrl && (
                  <div className="flex justify-center mb-2">
                    <video src={objectUrl} controls className="max-h-40 rounded-md" />
                  </div>
                )}
                {pendingFile.type.startsWith("audio/") && objectUrl && (
                  <div className="mb-2">
                    <audio src={objectUrl} controls className="w-full h-10" />
                  </div>
                )}
                <div className="flex items-center justify-between text-xs">
                  <div className="truncate font-medium text-foreground">
                    {pendingFile.name} ({formatBytes(pendingFile.size)})
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isSubmitting}
                    >
                      {t("Trocar")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={handleRemoveMedia}
                      disabled={isSubmitting}
                    >
                      <Trash size={14} className="mr-1" />
                      {t("Remover")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {!pendingFile && existingMedia && (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
                <div className="flex items-center gap-2 truncate">
                  <ImageSquare size={16} className="text-primary shrink-0" />
                  <span className="truncate font-medium">
                    {existingMedia.filename ||
                      `${existingMedia.type === "image" ? t("Imagem") : existingMedia.type === "video" ? t("Vídeo") : t("Áudio")} ${t("anexado")}`}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSubmitting}
                  >
                    {t("Trocar")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                    onClick={handleRemoveMedia}
                    disabled={isSubmitting}
                  >
                    <Trash size={14} className="mr-1" />
                    {t("Remover")}
                  </Button>
                </div>
              </div>
            )}

            {!pendingFile && !existingMedia && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full text-xs h-9 border-dashed"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSubmitting}
              >
                <Plus size={14} className="mr-1.5" />
                {t("Anexar foto, vídeo ou áudio")}
              </Button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,audio/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {validationError && (
            <p className="text-xs text-destructive font-medium">{validationError}</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? t("Salvando…")
              : editingMessage
                ? t("Salvar alterações")
                : t("Programar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { format } from "date-fns";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Clock,
  ClockCountdown,
  PencilSimple,
  Trash,
  ImageSquare,
  FileText,
  ArrowsClockwise,
} from "@/lib/ui/icons";
import {
  useScheduledMessages,
  useCancelScheduledMessage,
} from "@/hooks/inbox/useScheduledMessages";
import type { ScheduledMessageRow } from "@/lib/schemas/scheduled-messages";
import { ScheduleMessageDialog } from "@/components/inbox/composer/ScheduleMessageDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Props {
  conversationId: string;
}

export function ScheduledMessagesBanner({ conversationId }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const { data: messages, isLoading } = useScheduledMessages(conversationId);
  const cancelMutation = useCancelScheduledMessage();

  const [editingMessage, setEditingMessage] = useState<ScheduledMessageRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const pendingMessages = (messages ?? []).filter(
    (m) => m.status === "pending" || m.status === "processing"
  );

  if (isLoading || pendingMessages.length === 0) {
    return null;
  }

  const handleEdit = (msg: ScheduledMessageRow) => {
    setEditingMessage(msg);
    setDialogOpen(true);
  };

  const handleCancel = async (msg: ScheduledMessageRow) => {
    if (msg.status === "processing") return;
    try {
      await cancelMutation.mutateAsync({
        conversationId,
        messageId: msg.id,
      });
      toast.success(t("Mensagem programada cancelada."));
    } catch {
      // Toast disparado pelo onError
    }
  };

  return (
    <>
      <div className="border-t border-dashed border-primary/30 bg-primary/5 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between text-xs font-semibold text-primary">
          <div className="flex items-center gap-1.5">
            <Clock size={15} weight="fill" />
            <span>
              {pendingMessages.length === 1
                ? t("1 mensagem programada")
                : `${pendingMessages.length} ${t("mensagens programadas")}`}
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          {pendingMessages.map((msg) => {
            const isProcessing = msg.status === "processing";
            const scheduledDate = new Date(msg.scheduled_for);
            const formattedDate = format(scheduledDate, "dd/MM/yyyy 'às' HH:mm", {
              locale: localeDaData,
            });

            return (
              <div
                key={msg.id}
                className={cn(
                  "flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border border-border bg-background/80 p-2 text-xs shadow-xs transition-colors",
                  isProcessing && "opacity-75"
                )}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-foreground flex items-center gap-1">
                      <Clock size={13} className="text-primary" />
                      {formattedDate}
                    </span>
                    {isProcessing ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                        <ArrowsClockwise size={11} className="animate-spin" />
                        {t("Enviando…")}
                      </span>
                    ) : (
                      <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("Pendente")}
                      </span>
                    )}

                    {msg.media_type && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {msg.media_type === "image" ? (
                          <ImageSquare size={12} />
                        ) : (
                          <FileText size={12} />
                        )}
                        {msg.media_filename ||
                          (msg.media_type === "image"
                            ? t("Foto")
                            : msg.media_type === "video"
                              ? t("Vídeo")
                              : t("Áudio"))}
                      </span>
                    )}
                  </div>

                  {(msg.body || msg.caption) && (
                    <p className="line-clamp-2 text-muted-foreground text-[11px] break-words">
                      {msg.body || msg.caption}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0 self-end sm:self-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleEdit(msg)}
                    disabled={isProcessing}
                    title={t("Editar conteúdo da mensagem")}
                  >
                    <PencilSimple size={13} className="mr-1" />
                    {t("Editar")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleEdit(msg)}
                    disabled={isProcessing}
                    title={t("Alterar data/hora")}
                  >
                    <ClockCountdown size={13} className="mr-1" />
                    {t("Reagendar")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleCancel(msg)}
                    disabled={isProcessing || cancelMutation.isPending}
                    title={t("Cancelar agendamento")}
                  >
                    <Trash size={13} className="mr-1" />
                    {t("Cancelar")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {dialogOpen && (
        <ScheduleMessageDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setEditingMessage(null);
          }}
          conversationId={conversationId}
          editingMessage={editingMessage}
        />
      )}
    </>
  );
}

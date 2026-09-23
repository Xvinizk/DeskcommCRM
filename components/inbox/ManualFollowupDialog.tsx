"use client";

import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  conversationId: string;
}

interface ActiveConflictInfo {
  id: string;
  pointerId: string;
  flowName: string;
}

export function ManualFollowupDialog({
  open,
  onOpenChange,
  contactId,
  conversationId,
}: Props) {
  const t = useT();
  const qc = useQueryClient();
  const { data: flows, isLoading } = useFollowupFlows();

  const [search, setSearch] = useState("");
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [activeConflict, setActiveConflict] = useState<ActiveConflictInfo | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activePublishedFlows = useMemo(() => {
    return (flows ?? []).filter(
      (f) => f.status === "active" && f.active_version_id !== null
    );
  }, [flows]);

  const filteredFlows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activePublishedFlows;
    return activePublishedFlows.filter((f) => f.name.toLowerCase().includes(q));
  }, [activePublishedFlows, search]);

  const resetState = () => {
    setSearch("");
    setSelectedFlowId(null);
    setActiveConflict(null);
    setErrorMessage(null);
    setIsPending(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetState();
    }
    onOpenChange(nextOpen);
  };

  const handleStartFlow = async (replaceActive = false) => {
    if (!selectedFlowId) return;

    setIsPending(true);
    setErrorMessage(null);

    try {
      await apiClient.post("/api/v1/ai/followups/enrollments", {
        pointer_id: selectedFlowId,
        contact_id: contactId,
        conversation_id: conversationId || undefined,
        replace_active: replaceActive,
      });

      toast.success(
        replaceActive
          ? t("Fluxo anterior encerrado e novo follow-up iniciado.")
          : t("Follow-up iniciado com sucesso.")
      );

      // Invalida consultas relevantes da fila e da conversa
      qc.invalidateQueries({ queryKey: ["followup", "enrollments"] });
      qc.invalidateQueries({ queryKey: ["inbox", "conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["inbox", "messages", conversationId] });

      handleOpenChange(false);
    } catch (err: unknown) {
      const errObj = err as {
        status?: number;
        code?: string;
        message?: string;
        details?: { active_enrollment?: ActiveConflictInfo };
      };

      if (errObj?.status === 409 || errObj?.code === "conflict") {
        const conflict = errObj.details?.active_enrollment;
        if (conflict) {
          setActiveConflict(conflict);
          return;
        }
        setActiveConflict({
          id: "",
          pointerId: "",
          flowName: t("Outro follow-up ativo"),
        });
        return;
      }

      const msg = errObj?.message ?? t("Falha ao iniciar follow-up.");
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("Disparar Follow-up")}</DialogTitle>
          <DialogDescription>
            {t("Selecione um fluxo ativo para iniciar o atendimento deste contato.")}
          </DialogDescription>
        </DialogHeader>

        {activeConflict ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm space-y-2">
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                {t("Contato já em acompanhamento")}
              </p>
              <p className="text-text-muted">
                {t("Este contato já está no fluxo:")}{" "}
                <strong className="text-foreground">{activeConflict.flowName}</strong>.
              </p>
              <p className="text-xs text-text-muted">
                {t(
                  "O CRM mantém no máximo 1 follow-up ativo por contato para evitar envio duplicado de mensagens."
                )}
              </p>
            </div>

            {errorMessage && (
              <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() => setActiveConflict(null)}
              >
                {t("Voltar")}
              </Button>
              <Button
                variant="destructive"
                disabled={isPending}
                onClick={() => handleStartFlow(true)}
              >
                {isPending ? t("Encerrando...") : t("Encerrar atual e iniciar novo")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <Input
              placeholder={t("Buscar fluxo por nome...")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full"
            />

            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
              {isLoading && (
                <p className="text-sm text-text-muted py-4 text-center">
                  {t("Carregando fluxos...")}
                </p>
              )}

              {!isLoading && filteredFlows.length === 0 && (
                <p className="text-sm text-text-muted py-4 text-center">
                  {search
                    ? t("Nenhum fluxo encontrado com esse nome.")
                    : t("Nenhum fluxo ativo e publicado nesta organização.")}
                </p>
              )}

              {filteredFlows.map((flow) => {
                const isSelected = selectedFlowId === flow.id;
                return (
                  <div
                    key={flow.id}
                    onClick={() => setSelectedFlowId(flow.id)}
                    className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5 dark:bg-primary/10"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium leading-none">{flow.name}</p>
                      <span className="text-xs text-text-muted">
                        {t("Versão ativa publicada")}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-xs border-success-fg text-success-fg">
                      {t("Ativo")}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {errorMessage && (
              <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() => handleOpenChange(false)}
              >
                {t("Cancelar")}
              </Button>
              <Button
                disabled={!selectedFlowId || isPending}
                onClick={() => handleStartFlow(false)}
                data-testid="confirmar-disparo-followup"
              >
                {isPending ? t("Iniciando...") : t("Iniciar Fluxo")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

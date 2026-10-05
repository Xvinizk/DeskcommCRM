"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Warning as AlertTriangle, Trash as Trash2, CircleNotch as Loader2, Info } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import {
  useFollowupFlowDeletionSummary,
  usePermanentDeleteFollowupFlow,
} from "@/hooks/followup/useFollowupFlows";

interface Props {
  flowId: string;
  flowName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PermanentDeleteFlowDialog({
  flowId,
  flowName,
  open,
  onOpenChange,
}: Props) {
  const t = useT();
  const [typedName, setTypedName] = useState("");

  const { data: summary, isLoading: isLoadingSummary } = useFollowupFlowDeletionSummary(
    flowId,
    open,
  );
  const deleteMutation = usePermanentDeleteFollowupFlow();

  const isConfirmed = typedName.trim() === flowName.trim();
  const hasActive = (summary?.active_enrollments ?? 0) > 0;
  const hasAgents = (summary?.agent_references ?? 0) > 0;
  const hasRunningJobs = (summary?.running_jobs ?? 0) > 0;
  const isBlocked = hasActive || hasAgents || hasRunningJobs;

  const handleClose = (nextOpen: boolean) => {
    if (!deleteMutation.isPending) {
      setTypedName("");
      onOpenChange(nextOpen);
    }
  };

  const handleConfirm = async () => {
    if (!isConfirmed || isBlocked || deleteMutation.isPending) return;
    try {
      await deleteMutation.mutateAsync({ id: flowId, confirmationName: typedName.trim() });
      handleClose(false);
    } catch {
      // Toast já tratado no hook onError
      handleClose(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle size={20} aria-hidden />
            <DialogTitle>{t("Excluir permanentemente")}</DialogTitle>
          </div>
          <DialogDescription className="text-text-muted">
            {t("Esta ação é irreversível. Todos os dados de automação deste fluxo serão removidos permanentemente.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {isLoadingSummary ? (
            <div className="flex items-center justify-center py-6 text-sm text-text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("Calculando dependências e histórico…")}
            </div>
          ) : (
            <>
              {isBlocked && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <p className="font-semibold">{t("Exclusão permanente bloqueada:")}</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {hasActive && (
                      <li>
                        {t("Este fluxo possui contatos em execução. Cancele as execuções antes de excluí-lo.")}
                      </li>
                    )}
                    {hasAgents && (
                      <li>
                        {t("Este fluxo está sendo usado por um agente publicado. Remova o fluxo do agente antes de excluí-lo.")}
                      </li>
                    )}
                    {hasRunningJobs && (
                      <li>
                        {t("Existem tarefas em processamento para este fluxo. Aguarde a conclusão antes de excluí-lo.")}
                      </li>
                    )}
                  </ul>
                </div>
              )}

              <div className="rounded-md border border-border bg-surface-muted/50 p-3 text-xs space-y-1.5">
                <p className="font-medium text-text">{t("Serão removidos:")}</p>
                <ul className="list-disc pl-4 space-y-1 text-text-muted">
                  <li>
                    <strong className="text-text">{summary?.versions_count ?? 0}</strong> {t("versões do fluxo")}
                  </li>
                  <li>
                    <strong className="text-text">
                      {(summary?.completed_enrollments ?? 0) + (summary?.cancelled_enrollments ?? 0) + (summary?.other_historical_enrollments ?? 0)}
                    </strong>{" "}
                    {t("execuções históricas")}
                  </li>
                  <li>
                    <strong className="text-text">{summary?.total_events_count ?? 0}</strong>{" "}
                    {t("eventos de auditoria")}
                  </li>
                </ul>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-accent-50/10 p-2.5 text-xs text-text-muted">
                <Info size={16} className="mt-0.5 shrink-0 text-accent-500" aria-hidden />
                <span>
                  {t("Conversas, mensagens de WhatsApp e contatos dos clientes NÃO serão apagados. Apenas a automação será removida.")}
                </span>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <Label htmlFor="confirmation-input" className="text-xs font-normal">
                  {t("Para confirmar, digite exatamente o nome do fluxo:")}{" "}
                  <strong className="select-all font-semibold text-text">{flowName}</strong>
                </Label>
                <Input
                  id="confirmation-input"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder={flowName}
                  disabled={deleteMutation.isPending || isBlocked}
                  autoComplete="off"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={deleteMutation.isPending}
          >
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isConfirmed || isBlocked || deleteMutation.isPending || isLoadingSummary}
          >
            {deleteMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t("Excluir permanentemente")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PublishValidationError } from "@/lib/followup/validate-publish";
import { useT } from "@/hooks/i18n/useT";
import {
  useDisableFollowupFlow,
  usePublishFollowupFlow,
  useRollbackFollowupFlow,
  useSaveFollowupFlowDraft,
  useUpdateHandoffPolicy,
  type FollowupFlowDetailRow,
} from "@/hooks/followup/useFollowupFlow";
import {
  Trash,
  TreeStructure,
  ShareNetwork,
  ClockCounterClockwise,
  Archive,
  DownloadSimple,
  UploadSimple,
  CircleNotch,
} from "@/lib/ui/icons";
import { FlowStatusBadge } from "../../_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "../../_components/DeleteFollowupFlowButton";
import { TriggerConfigControl } from "./TriggerConfigControl";
import { ShareFlowDialog } from "./ShareFlowDialog";
import { FlowVersionsDialog } from "./FlowVersionsDialog";
import { ImportFlowJsonDialog } from "./ImportFlowJsonDialog";

interface Props {
  flowId: string;
  flow: FollowupFlowDetailRow;
  graph: FlowGraph;
  dirty: boolean;
  selection: "node" | "edge" | null;
  onDeleteSelection: () => void;
  onSaved: (graph: FlowGraph) => void;
  onPublishErrors: (errorsByNode: Record<string, string[]>) => void;
  onPublishSuccess: () => void;
  onAutoFit?: () => void;
  canAutoFit?: boolean;
  autosaving?: boolean;
  lastAutosavedAt?: Date | null;
}

const HANDOFF_LABEL: Record<FollowupFlowDetailRow["handoff_policy"], string> = {
  pause: "Pausar durante handoff",
  cancel: "Cancelar durante handoff",
  allow: "Permitir durante handoff",
};

export function PublishBar({
  flowId,
  flow,
  graph,
  dirty,
  selection,
  onDeleteSelection,
  onSaved,
  onPublishErrors,
  onPublishSuccess,
  onAutoFit,
  canAutoFit = false,
  autosaving = false,
  lastAutosavedAt,
}: Props) {
  const t = useT();
  const [openDeleteSelection, setOpenDeleteSelection] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [initialCreateBackup, setInitialCreateBackup] = useState(false);
  const [importJsonOpen, setImportJsonOpen] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);

  const save = useSaveFollowupFlowDraft(flowId);
  const publish = usePublishFollowupFlow(flowId);
  const disable = useDisableFollowupFlow(flowId);
  const rollback = useRollbackFollowupFlow(flowId);
  const handoffPolicy = useUpdateHandoffPolicy(flowId);

  const onSave = () => {
    save.mutate(graph, { onSuccess: () => onSaved(graph) });
  };

  const onPublish = async () => {
    try {
      await save.mutateAsync(graph);
      onSaved(graph);
    } catch {
      return; // save's own onError already toasted — don't attempt publish on a failed save
    }

    publish.mutate(undefined, {
      onSuccess: () => onPublishSuccess(),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "validation_failed") {
          const errors = (err.details?.errors as PublishValidationError[] | undefined) ?? [];
          const byNode: Record<string, string[]> = {};
          const flowLevel: string[] = [];
          for (const e of errors) {
            if (e.node_id) (byNode[e.node_id] ??= []).push(e.message);
            else flowLevel.push(e.message);
          }
          onPublishErrors(byNode);
          toast.error(t("Fluxo reprovado na validação — corrija os nós destacados."), {
            description: flowLevel.length > 0 ? flowLevel.join(" ") : undefined,
          });
          return;
        }
        showApiError(err);
      },
    });
  };

  const onDisable = () => disable.mutate();

  const canRollback = flow.versions_count > 1 && flow.previous_version_id !== null;
  const onRollback = () => {
    if (!flow.previous_version_id) return;
    rollback.mutate(flow.previous_version_id);
  };

  const onExportJson = async () => {
    setExportingJson(true);
    try {
      const res = await fetch(`/api/v1/ai/followup-flows/${flowId}/export`);
      const json = await res.json();
      if (!res.ok || !json.data) {
        toast.error(json.error?.message || t("Erro ao exportar JSON do Fluxo."));
        return;
      }

      const blob = new Blob([JSON.stringify(json.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const sanitizedName = (flow.name || "fluxo")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_");
      a.download = `fluxo_${sanitizedName}_export.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t("Arquivo JSON exportado com sucesso!"));
    } catch {
      toast.error(t("Erro de conexão ao exportar JSON."));
    } finally {
      setExportingJson(false);
    }
  };

  const busy = save.isPending || publish.isPending || disable.isPending || rollback.isPending;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-text">{flow.name}</h1>
          <FlowStatusBadge status={flow.status} />
          {dirty && (
            <Badge variant="warning" data-testid="dirty-indicator">
              {autosaving ? t("Salvando rascunho…") : t("Alterações não salvas")}
            </Badge>
          )}
          {!dirty && lastAutosavedAt && (
            <span className="text-[11px] text-text-muted hidden sm:inline">
              {t("Rascunho salvo")}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TriggerConfigControl flowId={flowId} triggerConfig={flow.trigger_config} />

          <Select
            value={flow.handoff_policy}
            onValueChange={(v) => handoffPolicy.mutate(v as FollowupFlowDetailRow["handoff_policy"])}
          >
            <SelectTrigger className="w-52" aria-label={t("Política de handoff")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(HANDOFF_LABEL) as Array<keyof typeof HANDOFF_LABEL>).map((k) => (
                <SelectItem key={k} value={k}>
                  {t(HANDOFF_LABEL[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Ações principais do Fluxo */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!dirty || busy}
            onClick={onSave}
          >
            {save.isPending ? t("Salvando…") : t("Salvar")}
          </Button>

          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={onPublish}
            data-testid="publish-button"
          >
            {publish.isPending ? t("Publicando…") : t("Publicar")}
          </Button>

          {/* Backup & Versionamento */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setInitialCreateBackup(true);
              setVersionsOpen(true);
            }}
            title={t("Criar backup manual deste Fluxo")}
          >
            <Archive size={14} aria-hidden className="mr-1.5" />
            {t("Criar backup")}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setInitialCreateBackup(false);
              setVersionsOpen(true);
            }}
            title={t("Ver histórico de versões e backups")}
          >
            <ClockCounterClockwise size={14} aria-hidden className="mr-1.5" />
            {t("Histórico de versões")}
          </Button>

          {/* Compartilhamento por link */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShareOpen(true)}
            title={t("Compartilhar Fluxo por link")}
          >
            <ShareNetwork size={14} aria-hidden className="mr-1.5" />
            {t("Compartilhar Fluxo")}
          </Button>

          {/* Exportar / Importar JSON */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exportingJson}
            onClick={onExportJson}
            title={t("Exportar estrutura do Fluxo como arquivo JSON")}
          >
            {exportingJson ? (
              <CircleNotch size={14} className="mr-1.5 animate-spin" />
            ) : (
              <DownloadSimple size={14} aria-hidden className="mr-1.5" />
            )}
            {t("Exportar JSON")}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setImportJsonOpen(true)}
            title={t("Importar novo Fluxo a partir de arquivo JSON")}
          >
            <UploadSimple size={14} aria-hidden className="mr-1.5" />
            {t("Importar JSON")}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || flow.status === "disabled"}
            onClick={onDisable}
          >
            {t("Desativar")}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !canRollback}
            onClick={onRollback}
            data-testid="rollback-button"
          >
            {t("Rollback")}
          </Button>

          {onAutoFit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canAutoFit}
              onClick={onAutoFit}
              data-testid="auto-fit-flow"
            >
              <TreeStructure size={14} aria-hidden className="mr-1" />
              {t("Organizar")}
            </Button>
          )}

          {selection ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive"
                data-testid="delete-selection"
                onClick={() => setOpenDeleteSelection(true)}
              >
                <Trash size={14} aria-hidden className="mr-1" />
                {selection === "node" ? t("Excluir nó") : t("Excluir aresta")}
              </Button>
              <AlertDialog open={openDeleteSelection} onOpenChange={setOpenDeleteSelection}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {selection === "node" ? t("Excluir este nó?") : t("Excluir esta aresta?")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {selection === "node"
                        ? t("Este nó e as arestas ligadas a ele são apagados. Não é possível desfazer.")
                        : t("A aresta entre os dois nós é apagada. Não é possível desfazer.")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault();
                        setOpenDeleteSelection(false);
                        onDeleteSelection();
                      }}
                    >
                      {t("Excluir")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <DeleteFollowupFlowButton flowId={flowId} flowName={flow.name} redirectToList />
          )}
        </div>
      </div>

      {/* Modais de Compartilhamento, Versões e Importação */}
      <ShareFlowDialog
        flowId={flowId}
        flowName={flow.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <FlowVersionsDialog
        flowId={flowId}
        flowName={flow.name}
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        initialCreateBackup={initialCreateBackup}
        onRestoreSuccess={() => {
          setVersionsOpen(false);
          window.location.reload();
        }}
      />

      <ImportFlowJsonDialog
        open={importJsonOpen}
        onOpenChange={setImportJsonOpen}
      />
    </>
  );
}

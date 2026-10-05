"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FlowArrow,
  Plus,
  Sparkle,
  UploadSimple,
  DotsThree,
  Archive,
  ArrowsClockwise,
  Copy,
  Trash,
  PencilSimple,
} from "@/lib/ui/icons";
import {
  useFollowupFlows,
  useArchiveFollowupFlow,
  useRestoreFollowupFlow,
  useDuplicateFollowupFlow,
  type FollowupFlowPointerRow,
} from "@/hooks/followup/useFollowupFlows";
import { FlowStatusBadge } from "./FlowStatusBadge";
import { ModelosDialog } from "./ModelosDialog";
import { NewFlowDialog } from "./NewFlowDialog";
import { ImportFlowJsonDialog } from "../[id]/_components/ImportFlowJsonDialog";
import { PermanentDeleteFlowDialog } from "./PermanentDeleteFlowDialog";

interface Props {
  initialData: FollowupFlowPointerRow[];
  canWrite: boolean;
}

function formatDate(iso?: string | null, idioma?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(idioma || "pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export function FlowsList({ initialData, canWrite }: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data } = useFollowupFlows({ initialData });

  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [modelosOpen, setModelosOpen] = useState(false);
  const [importJsonOpen, setImportJsonOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const archiveMutation = useArchiveFollowupFlow();
  const restoreMutation = useRestoreFollowupFlow();
  const duplicateMutation = useDuplicateFollowupFlow();

  const allFlows = Array.isArray(data) ? data : [];
  const activeFlows = allFlows.filter((f) => !f.archived_at);
  const archivedFlows = allFlows.filter((f) => Boolean(f.archived_at));

  const currentFlows = activeTab === "active" ? activeFlows : archivedFlows;

  const modelosButton = (
    <Button onClick={() => setModelosOpen(true)} className="w-full sm:w-auto">
      <Sparkle size={14} aria-hidden className="mr-2" /> {t("Começar de um modelo")}
    </Button>
  );

  const newFlowButton = (
    <Button onClick={() => setDialogOpen(true)} variant="outline" className="w-full sm:w-auto">
      <Plus size={14} aria-hidden className="mr-2" /> Novo fluxo
    </Button>
  );

  const importJsonButton = (
    <Button onClick={() => setImportJsonOpen(true)} variant="outline" className="w-full sm:w-auto">
      <UploadSimple size={14} aria-hidden className="mr-2" /> {t("Importar JSON")}
    </Button>
  );

  const dialogos = canWrite && (
    <>
      <NewFlowDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ModelosDialog
        open={modelosOpen}
        onOpenChange={setModelosOpen}
        nomesExistentes={allFlows.map((f) => f.name)}
      />
      <ImportFlowJsonDialog open={importJsonOpen} onOpenChange={setImportJsonOpen} />
      {deleteTarget && (
        <PermanentDeleteFlowDialog
          flowId={deleteTarget.id}
          flowName={deleteTarget.name}
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Barra superior de controles e filtros */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border bg-surface-muted p-1 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab("active")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              activeTab === "active"
                ? "bg-surface shadow-xs text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {t("Ativos")} ({activeFlows.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("archived")}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
              activeTab === "archived"
                ? "bg-surface shadow-xs text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {t("Arquivados")} ({archivedFlows.length})
          </button>
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {modelosButton}
            {newFlowButton}
            {importJsonButton}
          </div>
        )}
      </div>

      {/* Conteúdo da listagem */}
      {currentFlows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">
            {activeTab === "active"
              ? t("Nenhum fluxo de follow-up ativo")
              : t("Nenhum fluxo arquivado")}
          </h2>
          <p className="max-w-sm text-sm text-text-muted">
            {activeTab === "active"
              ? t(
                  "Follow-ups reengajam contatos após silêncio, mudança de etapa, uma regra em Webhooks ou a resposta do contato — sem depender de alguém lembrar de mandar mensagem.",
                )
              : t("Fluxos arquivados ficam armazenados aqui e não recebem novos contatos.")}
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {currentFlows.map((flow) => {
            const isArchived = Boolean(flow.archived_at);

            return (
              <li key={flow.id}>
                <Card className="flex h-full flex-col justify-between gap-3 p-4 transition-colors hover:border-accent-400">
                  {isArchived ? (
                    <div className="flex flex-1 flex-col gap-3">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 flex-1 truncate font-medium text-text-muted" title={flow.name}>
                          {flow.name}
                        </h3>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-text-muted">
                            {t("Arquivado")}
                          </span>
                          <FlowStatusBadge status={flow.status} />
                        </div>
                      </div>

                      <div className="rounded border border-dashed border-border p-2 text-xs text-text-muted">
                        <p suppressHydrationWarning>
                          {t("Arquivado em")}{" "}
                          <strong suppressHydrationWarning>{formatDate(flow.archived_at, tagDoIdioma)}</strong>
                        </p>
                        <p className="mt-0.5 text-text-secondary">
                          {t("Novas inscrições estão pausadas. Restaure para editar.")}
                        </p>
                      </div>

                      <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
                        <div>
                          <dt className="text-text-muted">{t("Versão")}</dt>
                          <dd className="font-mono">{flow.active_version_id ? "publicada" : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-text-muted">Handoff</dt>
                          <dd className="font-mono">{flow.handoff_policy}</dd>
                        </div>
                      </dl>
                    </div>
                  ) : (
                    <Link
                      href={`/app/ai/followups/${flow.id}`}
                      className="flex flex-1 flex-col gap-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 flex-1 truncate font-medium" title={flow.name}>
                          {flow.name}
                        </h3>
                        <FlowStatusBadge status={flow.status} />
                      </div>
                      <dl className="grid grid-cols-2 gap-2 pt-1 text-xs">
                        <div>
                          <dt className="text-text-muted">{t("Versão")}</dt>
                          <dd className="font-mono">{flow.active_version_id ? "publicada" : "—"}</dd>
                        </div>
                        <div>
                          <dt className="text-text-muted">Handoff</dt>
                          <dd className="font-mono">{flow.handoff_policy}</dd>
                        </div>
                      </dl>
                      <p suppressHydrationWarning className="mt-auto pt-2 text-xs text-text-muted">
                        {t("Atualizado em")}{" "}
                        <span suppressHydrationWarning>{formatDate(flow.updated_at, tagDoIdioma)}</span>
                      </p>
                    </Link>
                  )}

                  {canWrite && (
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      {isArchived ? (
                        <div className="flex w-full items-center justify-between gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => restoreMutation.mutate(flow.id)}
                            disabled={restoreMutation.isPending}
                          >
                            <ArrowsClockwise size={13} className="mr-1.5" />
                            {t("Restaurar")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleteTarget({ id: flow.id, name: flow.name })}
                          >
                            <Trash size={13} className="mr-1.5" />
                            {t("Excluir permanentemente")}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex w-full items-center justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                <DotsThree size={16} weight="bold" />
                                <span className="sr-only">Opções</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem asChild>
                                <Link
                                  href={`/app/ai/followups/${flow.id}`}
                                  className="flex items-center"
                                >
                                  <PencilSimple size={14} className="mr-2" />
                                  {t("Editar")}
                                </Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => duplicateMutation.mutate(flow.id)}
                                disabled={duplicateMutation.isPending}
                              >
                                <Copy size={14} className="mr-2" />
                                {t("Duplicar")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => archiveMutation.mutate(flow.id)}
                                disabled={archiveMutation.isPending}
                              >
                                <Archive size={14} className="mr-2" />
                                {t("Arquivar")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setDeleteTarget({ id: flow.id, name: flow.name })}
                                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                              >
                                <Trash size={14} className="mr-2" />
                                {t("Excluir permanentemente")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {dialogos}
    </div>
  );
}

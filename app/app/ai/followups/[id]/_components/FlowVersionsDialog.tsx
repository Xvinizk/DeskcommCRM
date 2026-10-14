"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ClockCounterClockwise,
  Plus,
  ArrowClockwise,
  Copy,
  DownloadSimple,
  CircleNotch,
  Eye,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface Props {
  flowId: string;
  flowName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestoreSuccess?: () => void;
  initialCreateBackup?: boolean;
}

interface VersionItem {
  id: string;
  created_at: string;
  label: string;
  kind: "publish" | "manual_backup" | "pre_restore";
  node_count: number;
  image_count: number;
  video_count: number;
  audio_count: number;
}

export function FlowVersionsDialog({
  flowId,
  flowName,
  open,
  onOpenChange,
  onRestoreSuccess,
  initialCreateBackup,
}: Props) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [newBackupName, setNewBackupName] = useState("");
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [duplicatingVersionId, setDuplicatingVersionId] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<VersionItem | null>(null);

  const loadVersions = useCallback(() => {
    setLoading(true);
    fetch(`/api/v1/ai/followup-flows/${flowId}/versions`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data?.versions) {
          setVersions(json.data.versions);
        }
      })
      .catch(() => {
        toast.error(t("Erro ao carregar histórico de versões."));
      })
      .finally(() => setLoading(false));
  }, [flowId, t]);

  useEffect(() => {
    if (open) {
      loadVersions();
      setNewBackupName("");
      if (initialCreateBackup) {
        setTimeout(() => backupInputRef.current?.focus(), 150);
      }
    }
  }, [open, loadVersions, initialCreateBackup]);

  const handleCreateBackup = async () => {
    if (!newBackupName.trim()) {
      toast.error(t("Informe um nome para o backup."));
      return;
    }

    setIsCreatingBackup(true);
    try {
      const res = await fetch(`/api/v1/ai/followup-flows/${flowId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newBackupName.trim() }),
      });

      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message || t("Erro ao criar backup."));
        return;
      }

      toast.success(t("Backup criado com sucesso!"));
      setNewBackupName("");
      loadVersions();
    } catch {
      toast.error(t("Erro de conexão ao criar backup."));
    } finally {
      setIsCreatingBackup(false);
    }
  };

  const handleRestore = async (version: VersionItem) => {
    const confirm = window.confirm(
      t(
        `Deseja restaurar a versão «${version.label}»?\n\nUm backup automático do seu rascunho atual será salvo antes da restauração para que nada seja perdido.`,
      ),
    );
    if (!confirm) return;

    setRestoringVersionId(version.id);
    try {
      const res = await fetch(
        `/api/v1/ai/followup-flows/${flowId}/versions/${version.id}/restore`,
        { method: "POST" },
      );

      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error?.message || t("Erro ao restaurar versão."));
        return;
      }

      toast.success(t("Versão restaurada como novo rascunho com sucesso!"));
      onOpenChange(false);
      if (onRestoreSuccess) onRestoreSuccess();
      else window.location.reload();
    } catch {
      toast.error(t("Erro de conexão ao restaurar versão."));
    } finally {
      setRestoringVersionId(null);
    }
  };

  const handleDuplicate = async (version: VersionItem) => {
    setDuplicatingVersionId(version.id);
    try {
      const res = await fetch(
        `/api/v1/ai/followup-flows/${flowId}/versions/${version.id}/duplicate`,
        { method: "POST" },
      );

      const json = await res.json();
      if (!res.ok || !json.data?.flow_id) {
        toast.error(json.error?.message || t("Erro ao duplicar versão."));
        return;
      }

      toast.success(t(`Fluxo duplicado como «${json.data.flow_name}»!`));
      window.open(`/app/ai/followups/${json.data.flow_id}`, "_blank");
    } catch {
      toast.error(t("Erro de conexão ao duplicar fluxo."));
    } finally {
      setDuplicatingVersionId(null);
    }
  };

  const handleExportJson = (versionId: string, label: string) => {
    window.open(
      `/api/v1/ai/followup-flows/${flowId}/export?version_id=${versionId}`,
      "_blank",
    );
    toast.success(t(`Exportando JSON de «${label}»...`));
  };

  const badgeForKind = (kind: VersionItem["kind"]) => {
    switch (kind) {
      case "publish":
        return <Badge variant="outline" className="border-primary/40 text-primary text-[10px]">{t("Publicação")}</Badge>;
      case "manual_backup":
        return <Badge variant="outline" className="border-info/40 text-info text-[10px]">{t("Backup Manual")}</Badge>;
      case "pre_restore":
        return <Badge variant="outline" className="border-warning/40 text-warning-fg text-[10px]">{t("Pré-restauração")}</Badge>;
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ClockCounterClockwise size={20} />
            </div>
            <div>
              <DialogTitle>{t("Histórico de Versões e Backups")}</DialogTitle>
              <DialogDescription className="text-xs text-text-muted mt-0.5">
                {flowName}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Formulário: Criar backup agora */}
        <div className="rounded-lg border border-border bg-surface-raised p-3.5 space-y-2.5">
          <label className="block text-xs font-semibold text-text">{t("Criar backup agora")}</label>
          <div className="flex items-center gap-2">
            <Input
              ref={backupInputRef}
              placeholder={t("Ex: FUNIL NEWBORN ANTES DO TESTE")}
              value={newBackupName}
              onChange={(e) => setNewBackupName(e.target.value)}
              className="text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateBackup();
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={isCreatingBackup || !newBackupName.trim()}
              onClick={handleCreateBackup}
              className="gap-1.5 shrink-0"
            >
              {isCreatingBackup ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              <span>{t("Salvar Backup")}</span>
            </Button>
          </div>
        </div>

        {/* Lista de Versões */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center p-8 gap-2">
              <CircleNotch size={24} className="animate-spin text-primary" />
              <p className="text-xs text-text-muted">{t("Carregando versões...")}</p>
            </div>
          ) : versions.length === 0 ? (
            <div className="p-8 text-center text-xs text-text-muted">
              {t("Nenhuma versão ou backup salvo ainda.")}
            </div>
          ) : (
            versions.map((ver, idx) => (
              <div
                key={ver.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border/80"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold truncate text-text" title={ver.label}>
                      {ver.label || `Versão ${versions.length - idx}`}
                    </span>
                    {badgeForKind(ver.kind)}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-text-muted">
                    <span>
                      {new Date(ver.created_at).toLocaleDateString(tagDeIdioma, {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span>·</span>
                    <span>{ver.node_count} {t("nós")}</span>
                    {(ver.image_count > 0 || ver.video_count > 0 || ver.audio_count > 0) && (
                      <>
                        <span>·</span>
                        <span>
                          {[
                            ver.image_count > 0 ? `${ver.image_count} img` : null,
                            ver.video_count > 0 ? `${ver.video_count} vid` : null,
                            ver.audio_count > 0 ? `${ver.audio_count} aud` : null,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Ações da versão */}
                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    title={t("Visualizar detalhes")}
                    onClick={() => setViewingVersion(ver)}
                  >
                    <Eye size={13} className="mr-1" />
                    <span>{t("Ver")}</span>
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5 text-xs text-primary hover:text-primary gap-1"
                    disabled={restoringVersionId === ver.id}
                    title={t("Restaurar como novo rascunho")}
                    onClick={() => handleRestore(ver)}
                  >
                    {restoringVersionId === ver.id ? (
                      <CircleNotch size={13} className="animate-spin" />
                    ) : (
                      <ArrowClockwise size={13} />
                    )}
                    <span>{t("Restaurar")}</span>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    disabled={duplicatingVersionId === ver.id}
                    title={t("Duplicar como novo Fluxo")}
                    onClick={() => handleDuplicate(ver)}
                  >
                    {duplicatingVersionId === ver.id ? (
                      <CircleNotch size={13} className="animate-spin" />
                    ) : (
                      <Copy size={13} />
                    )}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    title={t("Exportar JSON desta versão")}
                    onClick={() => handleExportJson(ver.id, ver.label)}
                  >
                    <DownloadSimple size={13} />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Modal de Pré-visualização simples */}
        {viewingVersion && (
          <Dialog open={Boolean(viewingVersion)} onOpenChange={() => setViewingVersion(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{viewingVersion.label}</DialogTitle>
                <DialogDescription className="text-xs text-text-muted">
                  {new Date(viewingVersion.created_at).toLocaleString(tagDeIdioma)}
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-muted">{t("Tipo:")}</span>
                  <span className="font-medium">{badgeForKind(viewingVersion.kind)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">{t("Total de nós:")}</span>
                  <span className="font-semibold">{viewingVersion.node_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">{t("Imagens:")}</span>
                  <span>{viewingVersion.image_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">{t("Vídeos:")}</span>
                  <span>{viewingVersion.video_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">{t("Áudios:")}</span>
                  <span>{viewingVersion.audio_count}</span>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => setViewingVersion(null)}>
                  {t("Fechar")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const v = viewingVersion;
                    setViewingVersion(null);
                    void handleRestore(v);
                  }}
                >
                  <ArrowClockwise size={13} className="mr-1.5" />
                  {t("Restaurar esta versão")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

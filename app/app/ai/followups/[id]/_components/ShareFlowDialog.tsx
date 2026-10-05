"use client";

import { useState, useEffect } from "react";
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
  ShareNetwork,
  Copy,
  Check,
  ArrowsClockwise,
  Trash,
  CircleNotch,
  Sparkle,
  ImageIcon,
  VideoCamera,
  MusicNote,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  flowId: string;
  flowName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShareData {
  has_share: boolean;
  token?: string;
  status?: string;
  snapshot_date?: string;
  node_count?: number;
  image_count?: number;
  video_count?: number;
  audio_count?: number;
  share_path?: string;
}

export function ShareFlowDialog({ flowId, flowName, open, onOpenChange }: Props) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [shareData, setShareData] = useState<ShareData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/v1/ai/followup-flows/${flowId}/share`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data) setShareData(json.data);
      })
      .catch(() => {
        toast.error(t("Erro ao consultar status de compartilhamento."));
      })
      .finally(() => setLoading(false));
  }, [flowId, open, t]);

  const handleShareAction = async (action: "create" | "update_snapshot" | "generate_new_token") => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/ai/followup-flows/${flowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok || !json.data) {
        toast.error(json.error?.message || t("Erro ao compartilhar fluxo."));
        return;
      }
      setShareData(json.data);
      toast.success(
        action === "update_snapshot"
          ? t("Snapshot compartilhado atualizado com sucesso!")
          : action === "generate_new_token"
            ? t("Novo link gerado com sucesso!")
            : t("Link de compartilhamento criado com sucesso!"),
      );
    } catch {
      toast.error(t("Erro de conexão ao compartilhar fluxo."));
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/v1/ai/followup-flows/${flowId}/share`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("Erro ao desativar link de compartilhamento."));
        return;
      }
      setShareData({ has_share: false });
      toast.success(t("Link de compartilhamento desativado com sucesso!"));
    } catch {
      toast.error(t("Erro de conexão ao desativar link."));
    } finally {
      setActionLoading(false);
    }
  };

  const shareUrl = shareData?.token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/fluxos/compartilhado/${shareData.token}`
    : "";

  const handleCopy = () => {
    if (!shareUrl) return;
    void copyToClipboard(shareUrl);
    setCopied(true);
    toast.success(t("Link copiado para a área de transferência!"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShareNetwork size={20} />
            </div>
            <div>
              <DialogTitle>{t("Compartilhar Fluxo")}</DialogTitle>
              <DialogDescription className="text-xs text-text-muted mt-0.5">
                {flowName}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center p-8 gap-2">
            <CircleNotch size={24} className="animate-spin text-primary" />
            <p className="text-xs text-text-muted">{t("Carregando informações...")}</p>
          </div>
        ) : shareData?.has_share && shareData.token ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border bg-surface-raised p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="gap-1 text-xs text-success-fg border-success/30 bg-success/5">
                  <Sparkle size={12} weight="fill" />
                  {t("Link Ativo")}
                </Badge>
                {shareData.snapshot_date && (
                  <span className="text-[11px] text-text-muted">
                    {t("Atualizado em")}{" "}
                    {new Date(shareData.snapshot_date).toLocaleDateString(tagDeIdioma, {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={shareUrl}
                  className="font-mono text-xs select-all bg-surface"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopy}
                  className="gap-1.5 shrink-0"
                >
                  {copied ? <Check size={14} className="text-success-fg" /> : <Copy size={14} />}
                  <span>{copied ? t("Copiado!") : t("Copiar")}</span>
                </Button>
              </div>

              {/* Mídias inclusas */}
              <div className="flex items-center gap-3 pt-1 text-xs text-text-muted">
                <span className="text-[11px] font-medium text-text">{t("Inclui no snapshot:")}</span>
                <span className="flex items-center gap-1 text-[11px]">
                  <ImageIcon size={13} className="text-info" /> {shareData.image_count ?? 0}
                </span>
                <span className="flex items-center gap-1 text-[11px]">
                  <VideoCamera size={13} className="text-success" /> {shareData.video_count ?? 0}
                </span>
                <span className="flex items-center gap-1 text-[11px]">
                  <MusicNote size={13} className="text-accent" /> {shareData.audio_count ?? 0}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => handleShareAction("update_snapshot")}
                  className="gap-1.5 text-xs"
                >
                  {actionLoading ? <CircleNotch size={13} className="animate-spin" /> : <ArrowsClockwise size={13} />}
                  <span>{t("Atualizar snapshot")}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => handleShareAction("generate_new_token")}
                  className="text-xs"
                >
                  <span>{t("Gerar novo link")}</span>
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={actionLoading}
                onClick={handleRevoke}
                className="text-xs text-error-fg hover:text-error-fg hover:bg-error/10 gap-1.5"
              >
                <Trash size={13} />
                <span>{t("Desativar link")}</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="rounded-lg border border-border bg-surface-raised p-4 space-y-2">
              <h4 className="text-sm font-medium">{t("Compartilhar com outra conta")}</h4>
              <p className="text-xs text-text-muted leading-relaxed">
                {t(
                  "Gera um link seguro e não enumerável com um snapshot imutável de nós, textos, imagens, vídeos e áudios. A conta que importar receberá cópias próprias das mídias sem dependência com a sua organização.",
                )}
              </p>
              <div className="flex items-center gap-3 pt-2 text-xs font-medium text-text">
                <span className="text-success-fg">✓ {t("Imagens")}</span>
                <span className="text-success-fg">✓ {t("Vídeos")}</span>
                <span className="text-success-fg">✓ {t("Áudios")}</span>
              </div>
            </div>

            <Button
              type="button"
              disabled={actionLoading}
              onClick={() => handleShareAction("create")}
              className="w-full gap-2 font-medium"
            >
              {actionLoading ? (
                <>
                  <CircleNotch size={16} className="animate-spin" />
                  <span>{t("Gerando snapshot imutável...")}</span>
                </>
              ) : (
                <>
                  <ShareNetwork size={16} />
                  <span>{t("Criar link compartilhável")}</span>
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

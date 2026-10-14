"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  LinkSimple,
  CircleNotch,
  TreeStructure,
  Sparkle,
  ArrowRight,
  Warning,
  ImageIcon,
  VideoCamera,
  MusicNote,
  CalendarBlank,
  CheckCircle,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { normalizeSharedFlowToken } from "@/lib/followup/sharing/normalize-token";
import { apiClient } from "@/lib/api/client";

interface SharedFlowMetadata {
  flow_name: string;
  node_count: number;
  image_count: number;
  video_count: number;
  audio_count: number;
  snapshot_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: (flowId: string) => void;
}

export function ImportFlowLinkDialog({ open, onOpenChange, onImportSuccess }: Props) {
  const t = useT();
  const router = useRouter();
  const tagDeIdioma = useTagDeIdioma();

  const [inputUrl, setInputUrl] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<SharedFlowMetadata | null>(null);
  const [isFetchingPreview, setIsFetchingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Limpar estados quando fecha o diálogo
  useEffect(() => {
    if (!open) {
      setInputUrl("");
      setToken(null);
      setPreview(null);
      setPreviewError(null);
      setImportError(null);
      setIsFetchingPreview(false);
      setIsImporting(false);
    }
  }, [open]);

  // Efeito ao digitar URL ou Token
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const trimmed = inputUrl.trim();
    if (!trimmed) {
      setToken(null);
      setPreview(null);
      setPreviewError(null);
      return;
    }

    const tokenExtracted = normalizeSharedFlowToken(trimmed);

    if (!tokenExtracted) {
      if (trimmed.length > 5) {
        setPreviewError(t("Esse link de compartilhamento não é válido."));
      } else {
        setPreviewError(null);
      }
      setToken(null);
      setPreview(null);
      return;
    }

    setToken(tokenExtracted);
    setPreviewError(null);
    setImportError(null);

    // Debounce busca de preview
    debounceTimerRef.current = setTimeout(async () => {
      setIsFetchingPreview(true);
      try {
        const res = await apiClient.get<any>(
          `/api/v1/ai/followup-flows/shared/${tokenExtracted}`,
        );

        if (res?.error) {
          if (res.error?.code === "not_found" || res.response?.status === 404) {
            setPreviewError(t("Esse fluxo compartilhado não está mais disponível ou expirou."));
          } else {
            setPreviewError(res.error?.message || t("Não foi possível carregar os dados desse fluxo."));
          }
          setPreview(null);
          return;
        }

        const data = (res?.data ?? res) as SharedFlowMetadata;
        setPreview(data);
        setPreviewError(null);
      } catch (err: any) {
        if (err?.status === 404 || err?.code === "not_found") {
          setPreviewError(t("Esse fluxo compartilhado não está mais disponível ou expirou."));
        } else {
          setPreviewError(err?.message || t("Falha de conexão ao validar o link compartilhado."));
        }
        setPreview(null);
      } finally {
        setIsFetchingPreview(false);
      }
    }, 400);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [inputUrl, t]);

  const handleImport = async () => {
    if (!token) return;

    setIsImporting(true);
    setImportError(null);

    try {
      const res = await apiClient.post<any>(
        `/api/v1/ai/followup-flows/shared/${token}/import`,
        {},
      );

      if (res?.error) {
        setImportError(res.error?.message || t("Não foi possível importar esse fluxo."));
        return;
      }

      const flowId = res?.data?.flow_id ?? res?.flow_id;
      if (!flowId) {
        setImportError(t("Não foi possível importar esse fluxo."));
        return;
      }

      toast.success(t("Fluxo importado com sucesso."));
      onOpenChange(false);

      if (onImportSuccess) {
        onImportSuccess(flowId);
      } else {
        router.push(`/app/ai/followups/${flowId}`);
      }
    } catch (err: any) {
      setImportError(err?.message || t("Falha de conexão ao importar o fluxo compartilhado."));
    } finally {
      setIsImporting(false);
    }
  };

  const formattedDate = preview?.snapshot_date
    ? new Date(preview.snapshot_date).toLocaleDateString(tagDeIdioma, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="import-flow-link-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LinkSimple size={18} weight="bold" />
            </div>
            <div>
              <DialogTitle>{t("Importar fluxo por link")}</DialogTitle>
              <DialogDescription>
                {t("Cole o link compartilhado ou o token do fluxo para importá-lo como um novo rascunho na sua conta.")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="shared-flow-input">{t("Link ou token do fluxo compartilhado")}</Label>
            <div className="relative">
              <Input
                id="shared-flow-input"
                data-testid="input-shared-flow-link"
                placeholder="https://.../fluxos/compartilhado/... ou TOKEN"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                disabled={isImporting}
                autoFocus
                className={previewError ? "border-error focus-visible:ring-error" : undefined}
              />
              {isFetchingPreview && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <CircleNotch size={16} className="animate-spin text-text-muted" />
                </div>
              )}
            </div>
            {previewError && (
              <p className="text-xs text-error-fg flex items-center gap-1 mt-1" data-testid="import-link-error">
                <Warning size={13} className="shrink-0" />
                <span>{previewError}</span>
              </p>
            )}
          </div>

          {/* Preview Card */}
          {preview && (
            <Card
              className="overflow-hidden border border-border/80 bg-surface-raised p-4 space-y-3"
              data-testid="import-link-preview"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Badge variant="outline" className="mb-1 gap-1 border-primary/30 text-[10px] text-primary">
                    <Sparkle size={10} weight="fill" />
                    <span>{t("Fluxo encontrado")}</span>
                  </Badge>
                  <h4 className="text-sm font-semibold text-text" title={preview.flow_name}>
                    {preview.flow_name}
                  </h4>
                </div>
                {formattedDate && (
                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                    <CalendarBlank size={12} />
                    {formattedDate}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted pt-1 border-t border-border/60">
                <span className="flex items-center gap-1 font-medium text-text">
                  <TreeStructure size={14} className="text-primary" />
                  {preview.node_count} {preview.node_count === 1 ? t("nó") : t("nós")}
                </span>
                {preview.image_count > 0 && (
                  <span className="flex items-center gap-1">
                    <ImageIcon size={14} className="text-info" />
                    {preview.image_count} {t("img")}
                  </span>
                )}
                {preview.video_count > 0 && (
                  <span className="flex items-center gap-1">
                    <VideoCamera size={14} className="text-success" />
                    {preview.video_count} {t("vídeo")}
                  </span>
                )}
                {preview.audio_count > 0 && (
                  <span className="flex items-center gap-1">
                    <MusicNote size={14} className="text-accent" />
                    {preview.audio_count} {t("áudio")}
                  </span>
                )}
              </div>

              <p className="text-[11px] text-text-muted italic">
                {t("O fluxo será importado como um novo rascunho independente.")}
              </p>
            </Card>
          )}

          {importError && (
            <div className="rounded-md border border-error/30 bg-error/10 p-3 text-xs text-error-fg flex items-start gap-1.5">
              <Warning size={14} className="shrink-0 mt-0.5" />
              <span>{importError}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isImporting}
          >
            {t("Cancelar")}
          </Button>

          <Button
            type="button"
            onClick={handleImport}
            disabled={!preview || isImporting || isFetchingPreview}
            data-testid="btn-confirm-import-link"
            className="gap-2"
          >
            {isImporting ? (
              <>
                <CircleNotch size={16} className="animate-spin" />
                <span>{t("Importando fluxo...")}</span>
              </>
            ) : (
              <>
                <span>{t("Importar fluxo")}</span>
                <ArrowRight size={16} />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

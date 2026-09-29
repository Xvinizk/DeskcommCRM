"use client";

import { useState, useRef } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  FileText,
  CircleNotch,
  CheckCircle,
  Warning,
  ArrowSquareOut,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: (flowId: string) => void;
}

export function ImportFlowJsonDialog({ open, onOpenChange, onImportSuccess }: Props) {
  const t = useT();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [jsonText, setJsonText] = useState("");
  const [loading, setLoading] = useState(false);
  const [importedFlow, setImportedFlow] = useState<{
    id: string;
    name: string;
    warnings?: string[];
  } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".json") && file.type !== "application/json") {
      toast.error(t("Selecione um arquivo .json válido."));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setJsonText(content);
      toast.success(t("Arquivo carregado com sucesso!"));
    };
    reader.onerror = () => {
      toast.error(t("Falha ao ler o arquivo selecionado."));
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!jsonText.trim()) {
      toast.error(t("Insira ou selecione um arquivo JSON de Fluxo."));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      toast.error(t("JSON com formatação inválida. Verifique o conteúdo."));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/v1/ai/followup-flows/import-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });

      const json = await res.json();
      if (!res.ok || !json.data) {
        toast.error(json.error?.message || t("Erro ao importar Fluxo."));
        return;
      }

      setImportedFlow({
        id: json.data.flow_id,
        name: json.data.flow_name,
        warnings: json.data.warnings,
      });

      toast.success(t("Fluxo importado com sucesso!"));
      onImportSuccess?.(json.data.flow_id);
    } catch {
      toast.error(t("Erro de conexão ao importar Fluxo."));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setJsonText("");
    setImportedFlow(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = (newOpen: boolean) => {
    if (!newOpen) {
      handleReset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText size={20} />
            </div>
            <div>
              <DialogTitle>{t("Importar Fluxo via JSON")}</DialogTitle>
              <DialogDescription className="text-xs text-text-muted mt-0.5">
                {t("Carregue um arquivo de backup ou cole a estrutura JSON do Fluxo.")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {importedFlow ? (
          <div className="space-y-4 py-3">
            <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 p-4 text-sm text-success-fg">
              <CheckCircle size={24} weight="fill" className="shrink-0" />
              <div>
                <p className="font-semibold">{t("Fluxo importado com sucesso!")}</p>
                <p className="text-xs text-text-muted mt-0.5">
                  {t("Criado como novo rascunho com o nome:")}{" "}
                  <strong className="text-text">{importedFlow.name}</strong>
                </p>
              </div>
            </div>

            {importedFlow.warnings && importedFlow.warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-medium text-warning-fg">
                  <Warning size={14} />
                  <span>{t("Avisos de compatibilidade:")}</span>
                </div>
                <ul className="list-disc pl-4 space-y-0.5 text-text-muted">
                  {importedFlow.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button
                type="button"
                onClick={() => {
                  handleClose(false);
                  router.push(`/app/ai/followups/${importedFlow.id}`);
                }}
                className="w-full gap-2"
              >
                <span>{t("Abrir no Fluxo")}</span>
                <ArrowSquareOut size={16} />
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="w-full gap-2 border-dashed h-16 flex flex-col items-center justify-center text-xs"
              >
                <span className="font-medium">{t("Clique para selecionar arquivo .json")}</span>
                <span className="text-[11px] text-text-muted">{t("ou cole o JSON abaixo")}</span>
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text">{t("Conteúdo JSON:")}</label>
              <Textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder='{"schema_version": 1, "flow": { ... }, "nodes": [ ... ], "edges": [ ... ]}'
                className="h-44 font-mono text-xs resize-none"
              />
            </div>

            <div className="rounded-md border border-border bg-surface-raised p-2.5 text-[11px] text-text-muted leading-relaxed">
              {t(
                "A importação nunca sobrescreve um Fluxo existente. Um novo Fluxo será criado em modo rascunho com novos identificadores para todos os nós.",
              )}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleClose(false)}
                disabled={loading}
              >
                {t("Cancelar")}
              </Button>
              <Button
                type="button"
                disabled={loading || !jsonText.trim()}
                onClick={handleImport}
                className="gap-2"
              >
                {loading ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    <span>{t("Importando...")}</span>
                  </>
                ) : (
                  <span>{t("Importar Fluxo")}</span>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FlowArrow,
  Check,
  CircleNotch,
  ArrowRight,
  ImageIcon,
  VideoCamera,
  MusicNote,
  CalendarBlank,
  Sparkle,
  TreeStructure,
} from "@/lib/ui/icons";

interface Props {
  token: string;
  flowName: string;
  nodeCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  snapshotDate: string;
  isAuthenticated: boolean;
}

export function SharedFlowClient({
  token,
  flowName,
  nodeCount,
  imageCount,
  videoCount,
  audioCount,
  snapshotDate,
  isAuthenticated,
}: Props) {
  const router = useRouter();
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    flow_id: string;
    flow_name: string;
    warnings?: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formattedDate = new Date(snapshotDate).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const handleImport = async () => {
    if (!isAuthenticated) {
      const currentPath = `/fluxos/compartilhado/${token}`;
      router.push(`/login?next=${encodeURIComponent(currentPath)}`);
      return;
    }

    setIsImporting(true);
    setError(null);

    try {
      const res = await fetch(`/api/v1/ai/followup-flows/shared/${token}/import`, {
        method: "POST",
      });

      const json = await res.json();
      if (!res.ok || !json.data?.flow_id) {
        setError(json.error?.message || "Falha ao importar o fluxo para sua conta.");
        return;
      }

      setImportResult(json.data);
    } catch {
      setError("Falha na conexão ao importar o fluxo.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center p-4 sm:p-6 lg:p-8">
      {/* Background glow effects */}
      <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-10 left-1/4 -z-10 h-72 w-72 rounded-full bg-accent/10 blur-[100px]" />

      <div className="w-full max-w-xl">
        {/* Header Branding */}
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner">
            <FlowArrow size={24} weight="bold" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Fluxo Compartilhado</span>
        </div>

        <Card className="overflow-hidden border border-border/80 bg-surface/90 shadow-2xl backdrop-blur-md">
          {/* Top Banner */}
          <div className="border-b border-border bg-gradient-to-r from-primary/5 via-accent/5 to-surface-raised p-6 text-center sm:p-8">
            <Badge variant="outline" className="mb-3 gap-1.5 border-primary/30 px-3 py-1 font-medium text-primary">
              <Sparkle size={13} weight="fill" />
              Snapshot Imutável
            </Badge>

            <h1 className="text-2xl font-bold tracking-tight text-text sm:text-3xl" title={flowName}>
              {flowName}
            </h1>

            <div className="mt-2.5 flex items-center justify-center gap-1.5 text-xs text-text-muted">
              <CalendarBlank size={14} className="shrink-0" />
              <span>Snapshot gerado em {formattedDate}</span>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <div className="flex flex-col items-center justify-center bg-surface p-4 text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary mb-1">
                <TreeStructure size={18} />
              </span>
              <span className="text-xl font-bold text-text">{nodeCount}</span>
              <span className="text-xs text-text-muted">Nós do Fluxo</span>
            </div>

            <div className="flex flex-col items-center justify-center bg-surface p-4 text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-info/10 text-info mb-1">
                <ImageIcon size={18} />
              </span>
              <span className="text-xl font-bold text-text">{imageCount}</span>
              <span className="text-xs text-text-muted">Imagens</span>
            </div>

            <div className="flex flex-col items-center justify-center bg-surface p-4 text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-success/10 text-success mb-1">
                <VideoCamera size={18} />
              </span>
              <span className="text-xl font-bold text-text">{videoCount}</span>
              <span className="text-xs text-text-muted">Vídeos</span>
            </div>

            <div className="flex flex-col items-center justify-center bg-surface p-4 text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent mb-1">
                <MusicNote size={18} />
              </span>
              <span className="text-xl font-bold text-text">{audioCount}</span>
              <span className="text-xs text-text-muted">Áudios</span>
            </div>
          </div>

          {/* Actions & Result */}
          <div className="p-6 sm:p-8 space-y-4">
            {importResult ? (
              <div className="rounded-xl border border-success/30 bg-success/5 p-5 text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
                  <Check size={28} weight="bold" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-text">Fluxo importado com sucesso</h3>
                  <p className="text-xs text-text-muted mt-1">
                    Um novo Fluxo foi criado na sua conta como rascunho com mídias e etapas vinculadas.
                  </p>
                </div>

                {importResult.warnings && importResult.warnings.length > 0 && (
                  <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-left text-xs text-warning-fg space-y-1">
                    <p className="font-semibold">Observações sobre a importação:</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {importResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="pt-2">
                  <Link href={`/app/ai/followups/${importResult.flow_id}`}>
                    <Button size="lg" className="w-full gap-2 font-medium shadow-md">
                      <span>Abrir no Fluxo</span>
                      <ArrowRight size={16} />
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="text-center text-xs text-text-muted">
                  {isAuthenticated
                    ? "O fluxo será clonado para a sua organização ativa como um novo rascunho."
                    : "Você precisará entrar na sua conta para importar o fluxo."}
                </div>

                {error && (
                  <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-center text-xs text-error-fg">
                    {error}
                  </div>
                )}

                <Button
                  onClick={handleImport}
                  disabled={isImporting}
                  size="lg"
                  className="w-full gap-2 py-6 text-base font-semibold shadow-lg hover:shadow-xl transition-all"
                >
                  {isImporting ? (
                    <>
                      <CircleNotch size={20} className="animate-spin" />
                      <span>Importando mídias e nós...</span>
                    </>
                  ) : (
                    <>
                      <span>Importar para minha conta</span>
                      <ArrowRight size={18} />
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

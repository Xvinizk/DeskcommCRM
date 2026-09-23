"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stageMoveConfigSchema } from "@/lib/followup/graph-schema";
import { etapasPorFunil } from "@/hooks/followup/useEtapasDeGatilho";
import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

export function StageMoveForm({
  config,
  onChange,
}: {
  config: ConfigOf<"stage_move">;
  onChange: (c: ConfigOf<"stage_move">) => void;
}) {
  const t = useT();
  const { etapas, carregando } = useEtapasDoFluxo();
  const [selectedStageId, setSelectedStageId] = useState(config.stage_id ?? "");
  const [error, setError] = useState<string | null>(null);

  const grupos = etapasPorFunil(etapas);

  const commit = (stageId: string) => {
    setSelectedStageId(stageId);
    const etapaObj = etapas.find((e) => e.stageId === stageId);
    if (!etapaObj) {
      setError(t("Escolha uma etapa válida."));
      return;
    }
    const candidate = {
      pipeline_id: etapaObj.pipelineId,
      stage_id: etapaObj.stageId,
    };
    const parsed = stageMoveConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="stage-select">{t("Etapa de destino")}</Label>
        {carregando ? (
          <p className="text-xs text-text-muted">{t("Carregando etapas...")}</p>
        ) : (
          <Select value={selectedStageId} onValueChange={commit}>
            <SelectTrigger id="stage-select">
              <SelectValue placeholder={t("Selecione a etapa do funil")} />
            </SelectTrigger>
            <SelectContent position="popper">
              {grupos.map((grupo) => (
                <SelectGroup key={grupo.id}>
                  <SelectLabel>{grupo.nome}</SelectLabel>
                  {grupo.etapas.map((e) => (
                    <SelectItem key={e.stageId} value={e.stageId}>
                      {e.stageName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
        {error && <p className="text-xs text-error-fg">{error}</p>}
      </div>
      <p className="text-xs text-text-muted">
        {t(
          "Move o lead automaticamente para o funil e etapa selecionados, atualizando o Kanban em tempo real."
        )}
      </p>
    </div>
  );
}

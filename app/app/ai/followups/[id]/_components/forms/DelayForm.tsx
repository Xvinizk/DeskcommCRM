"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { delayConfigSchema } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

export function DelayForm({
  config,
  onChange,
}: {
  config: ConfigOf<"delay">;
  onChange: (c: ConfigOf<"delay">) => void;
}) {
  const t = useT();
  const [durationValue, setDurationValue] = useState<number>(config.duration_value ?? 5);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">(config.unit ?? "minutes");
  const [immune, setImmune] = useState<boolean>(config.immune_to_reply ?? false);
  const [error, setError] = useState<string | null>(null);

  const commit = (val: number, nextUnit: "minutes" | "hours" | "days", nextImmune: boolean) => {
    setDurationValue(val);
    setUnit(nextUnit);
    setImmune(nextImmune);

    const parsed = delayConfigSchema.safeParse({
      duration_value: val,
      unit: nextUnit,
      immune_to_reply: nextImmune,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="delay-val">{t("Tempo")}</Label>
          <Input
            id="delay-val"
            type="number"
            min={1}
            max={9999}
            value={durationValue}
            onChange={(e) => commit(parseInt(e.target.value, 10) || 1, unit, immune)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="delay-unit">{t("Unidade")}</Label>
          <Select
            value={unit}
            onValueChange={(u: "minutes" | "hours" | "days") => commit(durationValue, u, immune)}
          >
            <SelectTrigger id="delay-unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">{t("Minutos")}</SelectItem>
              <SelectItem value="hours">{t("Horas")}</SelectItem>
              <SelectItem value="days">{t("Dias")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}

      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="delay-immune" className="text-sm font-medium">
            {t("Imune a respostas")}
          </Label>
          <p className="text-xs text-text-muted">
            {t("Não cancela nem interrompe o atraso se o cliente enviar uma mensagem.")}
          </p>
        </div>
        <Switch
          id="delay-immune"
          checked={immune}
          onCheckedChange={(checked) => commit(durationValue, unit, checked)}
        />
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

type TriggerConfigData = {
  type?: "manual" | "keyword";
  keywords?: string[];
  match_mode?: "exact" | "contains" | "starts_with";
  case_sensitive?: boolean;
};

export function TriggerForm({
  config,
  onChange,
}: {
  config: ConfigOf<"trigger">;
  onChange: (c: ConfigOf<"trigger">) => void;
}) {
  const t = useT();
  const cfg = (config ?? {}) as TriggerConfigData;

  const [triggerType, setTriggerType] = useState<"manual" | "keyword">(cfg.type ?? "manual");
  const [keywordsText, setKeywordsText] = useState<string>(
    Array.isArray(cfg.keywords) ? cfg.keywords.join("\n") : ""
  );
  const [matchMode, setMatchMode] = useState<"exact" | "contains" | "starts_with">(
    cfg.match_mode ?? "exact"
  );
  const [caseSensitive, setCaseSensitive] = useState<boolean>(Boolean(cfg.case_sensitive));

  const update = (patch: Partial<TriggerConfigData>) => {
    const nextType = patch.type ?? triggerType;
    const nextKwText = patch.keywords !== undefined ? patch.keywords.join("\n") : keywordsText;
    const nextMode = patch.match_mode ?? matchMode;
    const nextCase = patch.case_sensitive ?? caseSensitive;

    const parsedKeywords = nextKwText
      .split(/[\n,]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    if (nextType === "manual") {
      onChange({ type: "manual" });
    } else {
      onChange({
        type: "keyword",
        keywords: parsedKeywords,
        match_mode: nextMode,
        case_sensitive: nextCase,
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="trigger-type-select">{t("Tipo de gatilho")}</Label>
        <Select
          value={triggerType}
          onValueChange={(val: "manual" | "keyword") => {
            setTriggerType(val);
            update({ type: val });
          }}
        >
          <SelectTrigger id="trigger-type-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">{t("Manual / Disparo pela conversa")}</SelectItem>
            <SelectItem value="keyword">
              {t("Palavra-chave em mensagem recebida (WhatsApp)")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-text-muted">
          {triggerType === "manual"
            ? t("O fluxo é iniciado manualmente pelo atendente ou por API.")
            : t("O fluxo é iniciado automaticamente quando o cliente envia uma palavra-chave.")}
        </p>
      </div>

      {triggerType === "keyword" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="trigger-keywords">{t("Palavras-chave (uma por linha ou separadas por vírgula)")}</Label>
            <Textarea
              id="trigger-keywords"
              rows={3}
              value={keywordsText}
              placeholder={t("Ex: fluxo123, quero fotos, newborn")}
              onChange={(e) => {
                setKeywordsText(e.target.value);
                const list = e.target.value
                  .split(/[\n,]+/)
                  .map((k) => k.trim())
                  .filter(Boolean);
                update({ keywords: list });
              }}
            />
            <p className="text-xs text-text-muted">
              {t("Espaços no início e no fim são removidos automaticamente (trim).")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="trigger-match-mode">{t("Modo de correspondência")}</Label>
            <Select
              value={matchMode}
              onValueChange={(val: "exact" | "contains" | "starts_with") => {
                setMatchMode(val);
                update({ match_mode: val });
              }}
            >
              <SelectTrigger id="trigger-match-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">{t("Exatamente igual (exact)")}</SelectItem>
                <SelectItem value="contains">{t("Contém a palavra (contains)")}</SelectItem>
                <SelectItem value="starts_with">{t("Começa com a palavra (starts_with)")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="trigger-case-sensitive" className="text-sm font-medium cursor-pointer">
                {t("Diferenciar maiúsculas/minúsculas")}
              </Label>
              <p className="text-xs text-text-muted">
                {t("Se desativado, “FLUXO123” e “fluxo123” disparam da mesma forma.")}
              </p>
            </div>
            <Switch
              id="trigger-case-sensitive"
              checked={caseSensitive}
              onCheckedChange={(checked) => {
                setCaseSensitive(checked);
                update({ case_sensitive: checked });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

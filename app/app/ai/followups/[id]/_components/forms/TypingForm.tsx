"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { typingConfigSchema } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

export function TypingForm({
  config,
  onChange,
}: {
  config: ConfigOf<"typing">;
  onChange: (c: ConfigOf<"typing">) => void;
}) {
  const t = useT();
  const [duration, setDuration] = useState<number>(config.duration_seconds ?? 3);
  const [error, setError] = useState<string | null>(null);

  const commit = (val: number) => {
    setDuration(val);
    const parsed = typingConfigSchema.safeParse({ duration_seconds: val });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Duração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="typing-duration">{t("Duração do digitando (segundos)")}</Label>
        <Input
          id="typing-duration"
          type="number"
          min={1}
          max={60}
          value={duration}
          onChange={(e) => commit(parseInt(e.target.value, 10) || 1)}
        />
        {error && <p className="text-xs text-error-fg">{error}</p>}
      </div>
      <p className="text-xs text-text-muted">
        {t(
          "Exibe o status «digitando…» na conversa do WhatsApp antes do próximo nó, simulando a presença humana."
        )}
      </p>
    </div>
  );
}

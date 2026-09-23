"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { messageTextConfigSchema } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

export function MessageTextForm({
  config,
  onChange,
}: {
  config: ConfigOf<"message_text">;
  onChange: (c: ConfigOf<"message_text">) => void;
}) {
  const t = useT();
  const [body, setBody] = useState(config.body ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (newBody: string) => {
    setBody(newBody);
    const parsed = messageTextConfigSchema.safeParse({ body: newBody });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Mensagem inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="msg-text-body">{t("Mensagem de texto")}</Label>
          <span className="text-xs text-text-muted">{body.length}/4000</span>
        </div>
        <Textarea
          id="msg-text-body"
          value={body}
          rows={5}
          maxLength={4000}
          placeholder={t("Digite o texto a ser enviado pelo WhatsApp...")}
          onChange={(e) => commit(e.target.value)}
        />
        {error && <p className="text-xs text-error-fg">{error}</p>}
      </div>
      <p className="text-xs text-text-muted">
        {t("Dica: você pode utilizar variáveis como {{nome}} para personalizar a mensagem para o contato.")}
      </p>
    </div>
  );
}

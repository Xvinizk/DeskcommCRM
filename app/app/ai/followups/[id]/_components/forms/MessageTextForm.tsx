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
  fieldErrors,
  activeErrorField,
}: {
  config: ConfigOf<"message_text">;
  onChange: (c: ConfigOf<"message_text">) => void;
  fieldErrors?: Record<string, string>;
  activeErrorField?: string | null;
}) {
  const t = useT();
  const [body, setBody] = useState(config.body ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const externalError = fieldErrors?.["config.body"] || fieldErrors?.["body"];
  const displayError = localError || externalError;
  const isInvalid = Boolean(displayError);

  const commit = (newBody: string) => {
    setBody(newBody);
    const parsed = messageTextConfigSchema.safeParse({ body: newBody });
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? t("Mensagem inválida."));
      onChange({ body: newBody });
      return;
    }
    setLocalError(null);
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
          aria-invalid={isInvalid}
          className={isInvalid ? "border-error focus-visible:ring-error" : undefined}
          autoFocus={activeErrorField === "config.body" || activeErrorField === "body"}
        />
        {displayError && (
          <p className="text-xs text-error-fg" data-testid="field-error-body">
            {displayError}
          </p>
        )}
      </div>
      <p className="text-xs text-text-muted">
        {t("Dica: você pode utilizar variáveis como {{nome}} para personalizar a mensagem para o contato.")}
      </p>
    </div>
  );
}

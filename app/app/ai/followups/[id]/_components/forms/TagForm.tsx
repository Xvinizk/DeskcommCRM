"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "@/lib/ui/icons";
import { tagConfigSchema } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "./shared";

export function TagForm({
  config,
  onChange,
}: {
  config: ConfigOf<"tag">;
  onChange: (c: ConfigOf<"tag">) => void;
}) {
  const t = useT();
  const [action, setAction] = useState<"add" | "remove">(config.action ?? "add");
  const [tags, setTags] = useState<string[]>(config.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = (nextAction: "add" | "remove", nextTags: string[]) => {
    setAction(nextAction);
    setTags(nextTags);
    const parsed = tagConfigSchema.safeParse({ action: nextAction, tags: nextTags });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Adicione ao menos uma tag válida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const addTag = () => {
    const limpo = newTag.trim().toLowerCase();
    if (!limpo) return;
    if (tags.includes(limpo)) {
      setNewTag("");
      return;
    }
    const next = [...tags, limpo];
    setNewTag("");
    commit(action, next);
  };

  const removeTag = (tagToRemove: string) => {
    const next = tags.filter((t) => t !== tagToRemove);
    commit(action, next);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="tag-action">{t("Ação")}</Label>
        <Select
          value={action}
          onValueChange={(v: "add" | "remove") => commit(v, tags)}
        >
          <SelectTrigger id="tag-action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add">{t("Adicionar tags")}</SelectItem>
            <SelectItem value="remove">{t("Remover tags")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tag-input">{t("Tags")}</Label>
        <div className="flex gap-2">
          <Input
            id="tag-input"
            value={newTag}
            placeholder={t("Nome da tag...")}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <Button type="button" size="sm" variant="secondary" onClick={addTag}>
            <Plus size={14} className="mr-1" />
            {t("Inserir")}
          </Button>
        </div>
        {error && <p className="text-xs text-error-fg">{error}</p>}
      </div>

      <div className="flex flex-wrap gap-1.5 pt-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="rounded-full hover:bg-accent/20"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {tags.length === 0 && (
          <p className="text-xs text-text-muted">{t("Nenhuma tag configurada ainda.")}</p>
        )}
      </div>
    </div>
  );
}

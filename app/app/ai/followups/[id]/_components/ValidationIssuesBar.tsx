"use client";

import { useState } from "react";
import { Warning, X, CaretDown, CaretUp, ArrowRight } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { FlowValidationIssue } from "@/lib/followup/validation-contract";
import { cn } from "@/lib/utils";

interface Props {
  issues: FlowValidationIssue[];
  nodeLabels?: Map<string, string>;
  onSelectIssue: (issue: FlowValidationIssue) => void;
  onDismiss?: () => void;
}

export function ValidationIssuesBar({
  issues,
  nodeLabels,
  onSelectIssue,
  onDismiss,
}: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);

  if (issues.length === 0) return null;

  return (
    <div
      className="relative z-20 border-b border-error/30 bg-error/10 px-4 py-2 text-text backdrop-blur-md shadow-sm transition-all"
      data-testid="validation-issues-bar"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-error text-surface shadow-xs">
            <Warning size={14} weight="bold" />
          </div>
          <span className="text-xs font-semibold text-error-fg sm:text-sm">
            {issues.length === 1
              ? t("Encontramos 1 problema no fluxo")
              : t(`Encontramos ${issues.length} problemas no fluxo`)}
          </span>
          <span className="text-xs text-text-muted hidden sm:inline">
            — {t("clique em um item para ir até o nó e corrigir")}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-text-muted hover:text-text"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? t("Expandir lista") : t("Recolher lista")}
          >
            {collapsed ? (
              <>
                <span>{t("Ver detalhes")}</span>
                <CaretDown size={12} className="ml-1" />
              </>
            ) : (
              <>
                <span>{t("Recolher")}</span>
                <CaretUp size={12} className="ml-1" />
              </>
            )}
          </Button>

          {onDismiss && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-text-muted hover:text-text"
              onClick={onDismiss}
              aria-label={t("Fechar aviso")}
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="mt-2 flex flex-wrap gap-2 pt-1 max-h-48 overflow-y-auto pr-1">
          {issues.map((issue, idx) => {
            const label = issue.node_id ? nodeLabels?.get(issue.node_id) || issue.node_type || issue.node_id : t("Geral");
            return (
              <button
                key={`${issue.node_id ?? "global"}-${issue.field ?? ""}-${idx}`}
                type="button"
                onClick={() => onSelectIssue(issue)}
                className={cn(
                  "group flex items-center gap-2 rounded-lg border border-error/30 bg-surface/90 px-3 py-1.5 text-left text-xs shadow-xs",
                  "transition-all hover:border-error hover:bg-surface hover:shadow-md focus:outline-none focus:ring-2 focus:ring-error",
                )}
                data-testid={`validation-issue-item-${issue.node_id ?? "global"}`}
              >
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-error text-[11px] uppercase tracking-wide">
                      {label}
                    </span>
                    {issue.field && (
                      <span className="text-[10px] text-text-muted">
                        ({issue.field.replace(/^config\./, "")})
                      </span>
                    )}
                  </div>
                  <span className="text-text-muted group-hover:text-text truncate max-w-xs sm:max-w-md">
                    {issue.message}
                  </span>
                </div>
                <ArrowRight
                  size={12}
                  className="shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

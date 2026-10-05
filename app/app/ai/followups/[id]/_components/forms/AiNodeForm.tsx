"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Brain,
  Sparkle,
  ChatText,
  Clock,
  ArrowsClockwise,
  UserCircle,
  Warning,
  CheckCircle,
  CaretDown,
  CaretUp,
} from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import { useAgentVersions } from "@/hooks/ai/useAgentVersions";
import { etapasPorFunil } from "@/hooks/followup/useEtapasDeGatilho";
import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import type { ConfigOf } from "./shared";
import type {
  AiNodeMode,
  AiNodeVersionStrategy,
} from "@/lib/followup/graph-schema";
import {
  computeAiNodeTimeoutMs,
  normalizeLegacyTimeoutMs,
} from "@/lib/followup/graph-schema";

interface Props {
  config: ConfigOf<"ai_node">;
  onChange: (c: ConfigOf<"ai_node">) => void;
  ramosLigados?: string[];
  fieldErrors?: Record<string, string>;
  activeErrorField?: string | null;
}

export function AiNodeForm({ config, onChange, ramosLigados, fieldErrors }: Props) {
  const t = useT();
  const { data: agents = [], isLoading: isLoadingAgents } = useAgentsList();
  const { etapas } = useEtapasDoFluxo();
  const gruposEtapas = etapasPorFunil(etapas);

  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Estados locais derivados do config
  const mode: AiNodeMode = config.mode || "custom_prompt";
  const agentBinding = config.agent_binding || {
    agent_id: null,
    version_strategy: "published",
  };
  const agentId = agentBinding.agent_id || "";
  const versionStrategy: AiNodeVersionStrategy =
    agentBinding.version_strategy || "published";
  const pinnedVersionId = agentBinding.pinned_version_id || "";

  // Busca versões do agente selecionado se version_strategy for 'pinned'
  const { data: agentVersions = [] } = useAgentVersions(agentId, {
    initialData: [],
  });

  const selectedAgent = agents.find((a) => a.id === agentId);
  const isAgentMode =
    mode === "existing_agent" || mode === "existing_with_supplementary";


  // Helpers de mutação com limpeza de campos undefined
  const updateConfig = (patch: Partial<ConfigOf<"ai_node">>) => {
    const next = { ...config, ...patch };
    for (const key of Object.keys(next)) {
      if ((next as Record<string, unknown>)[key] === undefined) {
        delete (next as Record<string, unknown>)[key];
      }
    }
    onChange(next);
  };

  const handleModeChange = (newMode: AiNodeMode) => {
    if (newMode === "custom_prompt") {
      updateConfig({
        mode: newMode,
        agent_binding: undefined,
        agent_name: undefined,
        supplementary_instruction: undefined,
      });
    } else if (newMode === "existing_agent") {
      updateConfig({
        mode: newMode,
        agent_binding: {
          agent_id: agentId || null,
          version_strategy: versionStrategy,
          pinned_version_id: pinnedVersionId || null,
        },
        supplementary_instruction: undefined,
        custom_prompt: undefined,
      });
    } else {
      // existing_with_supplementary
      updateConfig({
        mode: newMode,
        agent_binding: {
          agent_id: agentId || null,
          version_strategy: versionStrategy,
          pinned_version_id: pinnedVersionId || null,
        },
        custom_prompt: undefined,
      });
    }
  };

  const handleAgentSelect = (newAgentId: string) => {
    const ag = agents.find((a) => a.id === newAgentId);
    updateConfig({
      agent_binding: {
        agent_id: newAgentId,
        version_strategy: versionStrategy,
        // Limpa IMEDIATAMENTE a versão fixada antiga para nunca vincular versão de Agent A em Agent B
        pinned_version_id: null,
      },
      agent_name: ag?.name || undefined,
    });
  };

  const handleVersionStrategyChange = (strat: AiNodeVersionStrategy) => {
    updateConfig({
      agent_binding: {
        agent_id: agentId || null,
        version_strategy: strat,
        pinned_version_id: strat === "pinned" ? pinnedVersionId || null : null,
      },
    });
  };

  const handlePinnedVersionSelect = (vId: string) => {
    updateConfig({
      agent_binding: {
        agent_id: agentId || null,
        version_strategy: "pinned",
        pinned_version_id: vId,
      },
    });
  };

  // Condições determinísticas
  const detConds =
    typeof config.deterministic_conditions === "object" &&
    !Array.isArray(config.deterministic_conditions) &&
    config.deterministic_conditions !== null
      ? (config.deterministic_conditions as Record<string, unknown>)
      : {};

  const minImages = (detConds.min_images as number) || 0;
  const requireAudio = Boolean(detConds.require_audio);
  const requireDocument = Boolean(detConds.require_document);
  const tagExists = (detConds.tag_exists as string) || "";
  const stageId = (detConds.stage_id as string) || "";

  const updateDetConds = (patch: Record<string, unknown>) => {
    const nextConds = { ...detConds, ...patch };
    // Limpar campos falsy / vazios
    Object.keys(nextConds).forEach((key) => {
      const val = nextConds[key];
      if (val === false || val === "" || val === undefined || val === null || val === 0) {
        delete nextConds[key];
      }
    });
    updateConfig({
      deterministic_conditions:
        Object.keys(nextConds).length > 0 ? nextConds : undefined,
    });
  };

  // Limites e Timeout — derivação determinística se apenas timeout_ms estiver presente
  const maxTurns = config.max_turns ?? 10;

  let initialTimeoutValue = config.timeout?.duration_value ?? 24;
  let initialTimeoutUnit = config.timeout?.unit ?? "hours";

  if (!config.timeout && typeof config.timeout_ms === "number") {
    const legacy = normalizeLegacyTimeoutMs(config.timeout_ms);
    initialTimeoutValue = legacy.duration_value;
    initialTimeoutUnit = legacy.unit;
  }

  const timeoutValue = initialTimeoutValue;
  const timeoutUnit = initialTimeoutUnit;

  const handleTimeoutChange = (newVal: number, newUnit: "minutes" | "hours" | "days") => {
    const duration = Math.max(1, newVal);
    const canonicalTimeout = {
      duration_value: duration,
      unit: newUnit,
    };
    updateConfig({
      timeout: canonicalTimeout,
      timeout_ms: computeAiNodeTimeoutMs(canonicalTimeout),
    });
  };

  // Validação humana inline
  let agentError: string | null = null;
  if (isAgentMode) {
    if (!agentId) {
      agentError = t("Selecione um agente.");
    } else if (selectedAgent?.paused_at) {
      agentError = t("Este agente está pausado.");
    } else if (!selectedAgent?.published_version_id) {
      agentError = t("Este agente ainda não possui uma versão publicada.");
    } else if (versionStrategy === "pinned" && !pinnedVersionId) {
      agentError = t("Selecione uma versão válida.");
    }
  }
  agentError =
    agentError ||
    fieldErrors?.["config.agent_binding.agent_id"] ||
    fieldErrors?.["config.agent_binding"] ||
    fieldErrors?.["agent_id"] ||
    null;

  return (
    <div className="space-y-6" data-testid="ai-node-form">
      {/* =========================================================================
          SEÇÃO 1: COMO A IA VAI ATENDER
          ========================================================================= */}
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {t("1. Como a IA vai atender")}
          </h3>
          <p className="text-xs text-text-muted">
            {t("Escolha se deseja reutilizar um agente configurado ou criar instruções exclusivas.")}
          </p>
        </div>

        {/* Seletor de Modo (3 Modos Amigáveis) */}
        <div className="grid grid-cols-1 gap-2">
          {/* Modo 1: existing_agent */}
          <button
            type="button"
            onClick={() => handleModeChange("existing_agent")}
            className={`flex flex-col items-start rounded-md border p-3 text-left transition-colors ${
              mode === "existing_agent"
                ? "border-accent bg-accent-soft/30 text-text ring-1 ring-accent"
                : "border-border bg-surface hover:bg-surface-hover text-text"
            }`}
            data-testid="mode-existing-agent"
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-xs font-semibold">
                {t("Usar um agente existente")}
              </span>
              <Brain size={14} className="text-accent" />
            </div>
            <span className="mt-1 text-xs text-text-muted">
              {t("Use um agente já configurado no CRM.")}
            </span>
          </button>

          {/* Modo 2: custom_prompt */}
          <button
            type="button"
            onClick={() => handleModeChange("custom_prompt")}
            className={`flex flex-col items-start rounded-md border p-3 text-left transition-colors ${
              mode === "custom_prompt"
                ? "border-accent bg-accent-soft/30 text-text ring-1 ring-accent"
                : "border-border bg-surface hover:bg-surface-hover text-text"
            }`}
            data-testid="mode-custom-prompt"
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-xs font-semibold">
                {t("Instrução personalizada")}
              </span>
              <Sparkle size={14} className="text-accent" />
            </div>
            <span className="mt-1 text-xs text-text-muted">
              {t("Configure a IA apenas para esta etapa.")}
            </span>
          </button>

          {/* Modo 3: existing_with_supplementary */}
          <button
            type="button"
            onClick={() => handleModeChange("existing_with_supplementary")}
            className={`flex flex-col items-start rounded-md border p-3 text-left transition-colors ${
              mode === "existing_with_supplementary"
                ? "border-accent bg-accent-soft/30 text-text ring-1 ring-accent"
                : "border-border bg-surface hover:bg-surface-hover text-text"
            }`}
            data-testid="mode-existing-supplementary"
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-xs font-semibold">
                {t("Agente + instrução da etapa")}
              </span>
              <ChatText size={14} className="text-accent" />
            </div>
            <span className="mt-1 text-xs text-text-muted">
              {t("Use um agente existente e acrescente orientações específicas para esta etapa.")}
            </span>
          </button>
        </div>

        {/* Seletor de Agente (visível nos modos que usam agente) */}
        {isAgentMode && (
          <div className="space-y-2 rounded-md border border-border bg-surface-subtle p-3">
            <Label htmlFor="agent-selector">{t("Agente da organização")}</Label>
            {isLoadingAgents ? (
              <p className="text-xs text-text-muted">{t("Carregando agentes...")}</p>
            ) : (
              <Select value={agentId} onValueChange={handleAgentSelect}>
                <SelectTrigger id="agent-selector" data-testid="agent-select-trigger">
                  <SelectValue placeholder={t("Selecione um agente")} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {agents
                    .filter((a) => !a.archived_at)
                    .map((a) => {
                      const isPaused = Boolean(a.paused_at);
                      const hasPublished = Boolean(a.published_version_id);
                      return (
                        <SelectItem
                          key={a.id}
                          value={a.id}
                          disabled={!hasPublished}
                          data-testid={`agent-option-${a.id}`}
                        >
                          <div className="flex items-center gap-2">
                            <span>{a.name}</span>
                            {isPaused && (
                              <Badge variant="outline" className="border-warning text-warning-fg text-[10px] px-1 py-0">
                                {t("Pausado")}
                              </Badge>
                            )}
                            {!hasPublished && (
                              <Badge variant="outline" className="border-error text-error-fg text-[10px] px-1 py-0">
                                {t("Sem versão publicada")}
                              </Badge>
                            )}
                            {hasPublished && !isPaused && (
                              <span className="text-[10px] text-text-muted">
                                · {t("Publicado")}
                              </span>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                </SelectContent>
              </Select>
            )}

            {agentError && (
              <p className="text-xs text-error-fg" data-testid="agent-error-msg">
                {agentError}
              </p>
            )}

            {/* Configurações Avançadas (Version Strategy) */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
                data-testid="toggle-advanced-config"
              >
                {advancedOpen ? <CaretUp size={12} /> : <CaretDown size={12} />}
                <span>{t("Configurações avançadas")}</span>
              </button>

              {advancedOpen && (
                <div className="mt-3 space-y-3 rounded-md border border-border/80 bg-surface p-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("Versão do agente")}</Label>
                    <Select
                      value={versionStrategy}
                      onValueChange={(val) =>
                        handleVersionStrategyChange(val as AiNodeVersionStrategy)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectItem value="published">
                          {t("Usar versão publicada atual")}
                        </SelectItem>
                        <SelectItem value="pinned">
                          {t("Fixar uma versão específica")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {versionStrategy === "pinned" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("Selecione a versão a fixar")}</Label>
                      <Select
                        value={pinnedVersionId}
                        onValueChange={handlePinnedVersionSelect}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid="pinned-version-select">
                          <SelectValue placeholder={t("Escolha uma versão")} />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {agentVersions.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {t("Versão")} {v.version_number} ({v.model})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* =========================================================================
          SEÇÃO 2: OBJETIVO DESTA ETAPA
          ========================================================================= */}
      <section className="space-y-4 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {t("2. Objetivo desta etapa")}
          </h3>
          <p className="text-xs text-text-muted">
            {t("Defina a meta que a IA deve perseguir nesta etapa do atendimento.")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="node-objective">{t("Qual é o objetivo desta etapa?")}</Label>
          <Input
            id="node-objective"
            placeholder={t("Fazer o cliente escolher um dos pacotes disponíveis.")}
            value={config.objective || ""}
            onChange={(e) => updateConfig({ objective: e.target.value })}
            maxLength={1000}
            data-testid="input-ai-objective"
          />
          <p className="text-[11px] text-text-muted">
            {t("A IA continuará conversando até atingir este objetivo ou algum limite da etapa.")}
          </p>
        </div>

        {/* Modo 3: Instrução Complementar */}
        {mode === "existing_with_supplementary" && (
          <div className="space-y-1.5">
            <Label htmlFor="node-supplementary">
              {t("Instruções específicas desta etapa")}
            </Label>
            <Textarea
              id="node-supplementary"
              rows={4}
              placeholder={t(
                "Você está agora na etapa de fechamento. Não repita a apresentação. Ajude o cliente a escolher o pacote."
              )}
              value={config.supplementary_instruction || ""}
              onChange={(e) =>
                updateConfig({ supplementary_instruction: e.target.value })
              }
              maxLength={2000}
              data-testid="input-ai-supplementary"
            />
            <p className="text-[11px] text-text-muted">
              <span className="font-medium text-accent">
                {t("Essa instrução complementa o agente.")}
              </span>{" "}
              {t("Ela não substitui a configuração principal dele.")}
            </p>
          </div>
        )}

        {/* Modo 2: Custom Prompt */}
        {mode === "custom_prompt" && (
          <div className="space-y-1.5">
            <Label htmlFor="node-custom-prompt">{t("Instruções para a IA")}</Label>
            <Textarea
              id="node-custom-prompt"
              rows={5}
              placeholder={t(
                "Você é a assistente de vendas da empresa. Converse de forma cordial, tire dúvidas sobre nossos serviços e pergunte qual é a melhor data para agendamento."
              )}
              value={config.custom_prompt || ""}
              onChange={(e) => updateConfig({ custom_prompt: e.target.value })}
              maxLength={4000}
              data-testid="input-ai-custom-prompt"
            />
          </div>
        )}
      </section>

      {/* =========================================================================
          SEÇÃO 3: QUANDO ESTA ETAPA TERMINA
          ========================================================================= */}
      <section className="space-y-4 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {t("3. Quando esta etapa termina")}
          </h3>
          <p className="text-xs text-text-muted">
            {t("Critérios para a IA considerar o atendimento concluído e avançar no fluxo.")}
          </p>
        </div>

        {/* Condição semântica */}
        <div className="space-y-1.5">
          <Label htmlFor="node-completion-condition">
            {t("Quando considerar esta etapa concluída?")}
          </Label>
          <Input
            id="node-completion-condition"
            placeholder={t("Quando o cliente informar qual pacote deseja.")}
            value={config.completion_condition || ""}
            onChange={(e) => updateConfig({ completion_condition: e.target.value })}
            maxLength={1000}
            data-testid="input-ai-completion-condition"
          />
          <p className="text-[11px] text-text-muted">
            {t("A IA usará esta condição para decidir quando seguir pela saída Concluído.")}
          </p>
        </div>

        {/* Condições determinísticas (amigáveis) */}
        <div className="space-y-2.5 rounded-md border border-border bg-surface-subtle p-3">
          <Label className="text-xs font-semibold text-text">
            {t("Concluir automaticamente quando...")}
          </Label>

          {/* Imagens */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="cond-images"
              className="h-4 w-4 rounded-md border-border text-accent focus:ring-accent cursor-pointer"
              checked={minImages > 0}
              onChange={(e) =>
                updateDetConds({ min_images: e.target.checked ? (minImages || 1) : 0 })
              }
              data-testid="checkbox-min-images"
            />
            <Label htmlFor="cond-images" className="text-xs font-normal cursor-pointer">
              {t("Receber pelo menos")}
            </Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={minImages || ""}
              placeholder="1"
              disabled={minImages <= 0}
              className="h-7 w-16 text-xs text-center"
              onChange={(e) =>
                updateDetConds({ min_images: parseInt(e.target.value, 10) || 1 })
              }
              data-testid="input-min-images"
            />
            <span className="text-xs text-text-muted">{t("imagens")}</span>
          </div>

          {/* Áudio */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="cond-audio"
              className="h-4 w-4 rounded-md border-border text-accent focus:ring-accent cursor-pointer"
              checked={requireAudio}
              onChange={(e) =>
                updateDetConds({ require_audio: e.target.checked })
              }
              data-testid="checkbox-require-audio"
            />
            <Label htmlFor="cond-audio" className="text-xs font-normal cursor-pointer">
              {t("Receber um áudio")}
            </Label>
          </div>

          {/* Documento */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="cond-doc"
              className="h-4 w-4 rounded-md border-border text-accent focus:ring-accent cursor-pointer"
              checked={requireDocument}
              onChange={(e) =>
                updateDetConds({ require_document: e.target.checked })
              }
              data-testid="checkbox-require-document"
            />
            <Label htmlFor="cond-doc" className="text-xs font-normal cursor-pointer">
              {t("Receber um documento")}
            </Label>
          </div>

          {/* Tag */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cond-tag"
                className="h-4 w-4 rounded-md border-border text-accent focus:ring-accent cursor-pointer"
                checked={Boolean(tagExists)}
                onChange={(e) =>
                  updateDetConds({ tag_exists: e.target.checked ? (tagExists || "interessado") : "" })
                }
                data-testid="checkbox-tag-exists"
              />
              <Label htmlFor="cond-tag" className="text-xs font-normal cursor-pointer">
                {t("Lead possuir determinada tag")}
              </Label>
            </div>
            {Boolean(tagExists) && (
              <Input
                value={tagExists}
                placeholder={t("Nome da tag")}
                className="h-7 text-xs ml-6 max-w-xs"
                onChange={(e) => updateDetConds({ tag_exists: e.target.value })}
                data-testid="input-tag-exists"
              />
            )}
          </div>

          {/* Etapa do Funil */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cond-stage"
                className="h-4 w-4 rounded-md border-border text-accent focus:ring-accent cursor-pointer"
                checked={Boolean(stageId)}
                onChange={(e) =>
                  updateDetConds({ stage_id: e.target.checked ? (stageId || etapas[0]?.stageId || "") : "" })
                }
                data-testid="checkbox-stage-id"
              />
              <Label htmlFor="cond-stage" className="text-xs font-normal cursor-pointer">
                {t("Lead estiver em determinada etapa")}
              </Label>
            </div>
            {Boolean(stageId) && (
              <div className="ml-6 max-w-xs">
                <Select
                  value={stageId}
                  onValueChange={(val) => updateDetConds({ stage_id: val })}
                >
                  <SelectTrigger className="h-7 text-xs" data-testid="select-stage-id">
                    <SelectValue placeholder={t("Selecione a etapa")} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {gruposEtapas.map((grupo) => (
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
              </div>
            )}
          </div>
        </div>
      </section>

      {/* =========================================================================
          SEÇÃO 4: LIMITES E SEGURANÇA
          ========================================================================= */}
      <section className="space-y-4 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {t("4. Limites e segurança")}
          </h3>
          <p className="text-xs text-text-muted">
            {t("Proteja o fluxo contra loops e conversas sem fim.")}
          </p>
        </div>

        {/* Max Turns */}
        <div className="space-y-1.5">
          <Label htmlFor="node-max-turns">
            {t("Máximo de mensagens do cliente nesta etapa")}
          </Label>
          <Input
            id="node-max-turns"
            type="number"
            min={1}
            max={100}
            value={maxTurns}
            onChange={(e) =>
              updateConfig({ max_turns: parseInt(e.target.value, 10) || 10 })
            }
            className="w-32 text-center"
            data-testid="input-max-turns"
          />
          <p className="text-[11px] text-text-muted">
            {t("Se o limite for atingido antes da conclusão, o Fluxo seguirá pela saída Máx. de turnos.")}
          </p>
        </div>

        {/* Timeout */}
        <div className="space-y-1.5">
          <Label>{t("Tempo máximo nesta etapa")}</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={9999}
              value={timeoutValue}
              onChange={(e) =>
                handleTimeoutChange(parseInt(e.target.value, 10) || 24, timeoutUnit)
              }
              className="w-24 text-center"
              data-testid="input-timeout-value"
            />
            <Select
              value={timeoutUnit}
              onValueChange={(val: "minutes" | "hours" | "days") =>
                handleTimeoutChange(timeoutValue, val)
              }
            >
              <SelectTrigger className="w-32" data-testid="select-timeout-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="minutes">{t("minutos")}</SelectItem>
                <SelectItem value="hours">{t("horas")}</SelectItem>
                <SelectItem value="days">{t("dias")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-text-muted">
            {t("Se o cliente não concluir esta etapa dentro desse período, o Fluxo seguirá pela saída Tempo esgotado.")}
          </p>
        </div>
      </section>

      {/* =========================================================================
          SEÇÃO 5: SAÍDAS DO FLUXO
          ========================================================================= */}
      <section className="space-y-3 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {t("5. Saídas do fluxo")}
          </h3>
          <p className="text-xs text-text-muted">
            {t("Conecte os nós de continuação a partir de cada uma destas 5 saídas:")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-surface-subtle p-3 text-xs">
          <div className="flex items-start gap-2">
            <CheckCircle size={14} className="mt-0.5 text-success shrink-0" />
            <div>
              <span className="font-semibold text-text">{t("Concluído")}</span>
              <p className="text-text-muted">{t("Objetivo atingido.")}</p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Clock size={14} className="mt-0.5 text-warning shrink-0" />
            <div>
              <span className="font-semibold text-text">{t("Tempo esgotado")}</span>
              <p className="text-text-muted">
                {t("O cliente não concluiu dentro do prazo.")}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <ArrowsClockwise size={14} className="mt-0.5 text-info shrink-0" />
            <div>
              <span className="font-semibold text-text">{t("Máx. de turnos")}</span>
              <p className="text-text-muted">
                {t("O limite de mensagens foi atingido.")}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <UserCircle size={14} className="mt-0.5 text-accent shrink-0" />
            <div>
              <span className="font-semibold text-text">
                {t("Atendimento humano")}
              </span>
              <p className="text-text-muted">
                {t("A IA decidiu transferir para uma pessoa.")}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Warning size={14} className="mt-0.5 text-error shrink-0" />
            <div>
              <span className="font-semibold text-text">{t("Erro")}</span>
              <p className="text-text-muted">
                {t("Ocorreu uma falha técnica ou configuração inválida.")}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

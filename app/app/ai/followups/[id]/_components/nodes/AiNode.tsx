"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function AiNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const config = (data.config ?? {}) as ConfigOf<"ai_node">;

  // Verificação de configuração pendente para aviso visual no canvas
  const errors: string[] = [...(data.errors ?? [])];
  const isAgentMode =
    config.mode === "existing_agent" || config.mode === "existing_with_supplementary";

  if (isAgentMode && !config.agent_binding?.agent_id) {
    if (!errors.some((e) => e.includes(t("Configuração pendente")))) {
      errors.push(t("Configuração pendente: selecione um agente"));
    }
  } else if (
    config.mode === "custom_prompt" &&
    !config.custom_prompt?.trim() &&
    !config.objective?.trim()
  ) {
    if (!errors.some((e) => e.includes(t("Configuração pendente")))) {
      errors.push(t("Configuração pendente: informe instruções para a IA"));
    }
  }

  const branches = nodeBranches({
    type: "ai_node",
    config,
  });

  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.ai_node}
      label={data.label || t("IA")}
      subtitle={describeNodeConfig("ai_node", config, t)}
      selected={selected}
      errors={errors.length > 0 ? errors : undefined}
      branches={branches}
    />
  );
}

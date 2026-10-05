import type { z } from "zod";
import type { PublishValidationError } from "./validate-publish";

export interface FlowValidationIssue {
  node_id: string | null;
  edge_id?: string | null;
  node_type?: string | null;
  field?: string | null;
  code: string;
  message: string;
  branch_id?: string | null;
}

/**
 * Normaliza os erros do Zod ao validar um draft de fluxo (nós e arestas)
 * em issues estruturadas e localizadas por nó, tipo e campo.
 */
export function zodErrorToFlowIssues(
  error: z.ZodError,
  rawDraft?: unknown,
): FlowValidationIssue[] {
  const rawGraph =
    rawDraft && typeof rawDraft === "object" && "draft_graph" in rawDraft
      ? (rawDraft as { draft_graph?: { nodes?: any[]; edges?: any[] } }).draft_graph
      : (rawDraft as { nodes?: any[]; edges?: any[] } | undefined);

  const rawNodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : [];

  return error.issues.map((issue) => {
    let nodeId: string | null = null;
    let nodeType: string | null = null;
    let edgeId: string | null = null;
    let field: string | null = null;

    const path = issue.path;
    const nodesIdx = path.indexOf("nodes");
    const edgesIdx = path.indexOf("edges");

    if (nodesIdx !== -1 && typeof path[nodesIdx + 1] === "number") {
      const idx = path[nodesIdx + 1] as number;
      const node = rawNodes[idx];
      nodeId = node?.id ?? null;
      nodeType = node?.type ?? null;
      field = path.slice(nodesIdx + 2).join(".");
    } else if (edgesIdx !== -1 && typeof path[edgesIdx + 1] === "number") {
      const idx = path[edgesIdx + 1] as number;
      const edge = rawEdges[idx];
      edgeId = edge?.id ?? null;
      nodeId = edge?.source ?? null;
      field = path.slice(edgesIdx + 2).join(".");
    } else if (path.length > 0) {
      field = path.join(".");
    }

    let message = issue.message;

    // Mensagens amigáveis para campos comuns
    if (field === "config.body" || (nodeType === "message_text" && (field === "config" || !field))) {
      message = "A mensagem não pode ficar vazia.";
    } else if (
      field === "config.media_url" ||
      field === "config.media_storage_path" ||
      ((nodeType === "message_image" || nodeType === "message_video" || nodeType === "message_audio") &&
        (field === "config" || message.includes("media_storage_path or media_url is required")))
    ) {
      message = "Arquivo ou URL de mídia é obrigatória.";
      if (!field || field === "config") field = "config.media_url";
    } else if (nodeType === "ai_node") {
      if (field?.includes("agent") || message.includes("agent")) {
        message = "Selecione um agente para o nó de IA.";
        field = "config.agent_binding.agent_id";
      } else if (field === "config.custom_prompt" || field === "config.objective" || field === "config") {
        message = "Informe as instruções ou objetivo para o nó de IA.";
      }
    } else if (nodeType === "stage_move" && (field === "config.stage_id" || field === "config")) {
      message = "Selecione a etapa de destino.";
      field = "config.stage_id";
    } else if (nodeType === "tag" && (field === "config.tags" || field === "config")) {
      message = "Informe pelo menos uma tag.";
    } else if (field === "nodes" && (issue.code === "too_small" || message.includes("at least 2"))) {
      message = "O fluxo precisa ter pelo menos 2 nós.";
    }

    return {
      node_id: nodeId,
      node_type: nodeType,
      edge_id: edgeId,
      field: field || null,
      code: issue.code,
      message,
    };
  });
}

/**
 * Converte erros do validador de publish em FlowValidationIssue.
 */
export function publishErrorsToFlowIssues(
  errors: PublishValidationError[],
  nodes?: Array<{ id: string; type: string; label?: string }>,
): FlowValidationIssue[] {
  const nodeMap = new Map((nodes ?? []).map((n) => [n.id, n.type]));

  return errors.map((err) => {
    let field: string | null = null;
    if (err.code === "stage_move_missing_stage") {
      field = "config.stage_id";
    } else if (err.code.startsWith("ai_node_agent")) {
      field = "config.agent_binding.agent_id";
    } else if (
      err.code === "ai_node_missing_instruction" ||
      err.code.startsWith("ai_node_incompatible_custom_prompt")
    ) {
      field = "config.custom_prompt";
    } else if (err.code.startsWith("ai_node_incompatible_supplementary_instruction")) {
      field = "config.supplementary_instruction";
    } else if (err.code.startsWith("empty_check_value") || err.code.startsWith("check_")) {
      field = "config.checks";
    }

    return {
      node_id: err.node_id && err.node_id.trim() ? err.node_id : null,
      node_type: err.node_id ? nodeMap.get(err.node_id) ?? null : null,
      field,
      code: err.code,
      message: err.message,
      branch_id: err.branch_id ?? null,
    };
  });
}

/**
 * Formata mensagem sucinta para o toast ou cabeçalho de erro.
 */
export function formatFlowIssuesToastMessage(
  issues: FlowValidationIssue[],
  nodeLabels?: Map<string, string>,
): string {
  if (issues.length === 0) {
    return "Existem problemas no fluxo.";
  }

  if (issues.length === 1) {
    const issue = issues[0]!;
    const label = issue.node_id ? nodeLabels?.get(issue.node_id) : null;
    if (label) {
      return `Há um problema no nó '${label}': ${issue.message}`;
    }
    return `Há um problema no fluxo: ${issue.message}`;
  }

  return `Encontramos ${issues.length} problemas no fluxo.`;
}

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/followup/graph-schema";
import { normalizeAiNodeTimeout } from "@/lib/followup/graph-schema";
import { duplicateFlowMedia } from "./media-duplication";
import { logger } from "@/lib/logger";

export interface ImportFlowResult {
  ok: boolean;
  flow_id?: string;
  flow_name?: string;
  warnings?: string[];
  error?: string;
}

interface ImportFlowParams {
  admin: SupabaseClient;
  targetOrgId: string;
  userId: string;
  flowName: string;
  handoffPolicy?: "pause" | "cancel" | "allow";
  triggerConfig?: Record<string, unknown>;
  graph: FlowGraph;
}

/**
 * Encontra um nome não colidente para o fluxo na organização de destino.
 */
async function resolveUniqueFlowName(
  admin: SupabaseClient,
  orgId: string,
  baseName: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", orgId);

  const existingNames = new Set((existing ?? []).map((r) => r.name.toLowerCase().trim()));

  if (!existingNames.has(baseName.toLowerCase().trim())) {
    return baseName;
  }

  const candidateBase = `${baseName} (Importado)`;
  if (!existingNames.has(candidateBase.toLowerCase().trim())) {
    return candidateBase;
  }

  let counter = 2;
  while (existingNames.has(`${baseName} (Importado ${counter})`.toLowerCase().trim())) {
    counter++;
  }
  return `${baseName} (Importado ${counter})`;
}

/**
 * Importa um fluxo para a organização de destino de forma totalmente independente:
 * - Novos IDs internos para todos os nós
 * - Arestas reconstruídas apontando para os novos IDs
 * - Mídias duplicadas no Storage da organização de destino
 * - Mapeamento seguro de etapas e funis
 * - Nunca sobrescreve fluxo existente
 * - Criado sempre como rascunho (status: draft)
 */
export async function importFlowIntoOrg({
  admin,
  targetOrgId,
  userId,
  flowName,
  handoffPolicy = "pause",
  triggerConfig = { kind: "manual" },
  graph,
}: ImportFlowParams): Promise<ImportFlowResult> {
  const warnings: string[] = [];

  try {
    const uniqueName = await resolveUniqueFlowName(admin, targetOrgId, flowName);

    // 1. Carregar funis e etapas da organização de destino para compatibilizar nós de stage_move
    const { data: targetStages } = await admin
      .from("crm_stages")
      .select("id, pipeline_id, name")
      .eq("organization_id", targetOrgId)
      .eq("is_archived", false);

    // 2. Mapeamento de IDs antigos para novos IDs
    const idMap = new Map<string, string>();
    const oldNodes = graph.nodes ?? [];

    for (const node of oldNodes) {
      const newId = `${node.type}-${randomUUID().slice(0, 8)}`;
      idMap.set(node.id, newId);
    }

    // 3. Reconstruir nós com novos IDs e duplicar mídias
    const newNodes: FlowNode[] = [];

    for (const node of oldNodes) {
      const newId = idMap.get(node.id) ?? node.id;
      const nodeConfig = { ...(node.config as Record<string, unknown>) };

      // Duplicação de mídias anexadas
      if (
        (node.type === "message_image" ||
          node.type === "message_video" ||
          node.type === "message_audio") &&
        nodeConfig.media_storage_path
      ) {
        const sourcePath = String(nodeConfig.media_storage_path);
        const mime = (nodeConfig.media_mime as string) || "application/octet-stream";

        const dupResult = await duplicateFlowMedia(admin, {
          sourceStoragePath: sourcePath,
          targetOrgId,
          mime,
        });

        if (dupResult.ok && dupResult.newStoragePath) {
          nodeConfig.media_storage_path = dupResult.newStoragePath;
          delete nodeConfig.media_url;
        } else {
          warnings.push(
            `A mídia do nó «${node.label}» não pôde ser transferida automaticamente. Substitua-a no editor.`,
          );
        }
      }

      // Compatibilizar nós de movimentação de etapa (stage_move)
      if (node.type === "stage_move") {
        // NUNCA reutilizar stage_id da Organização A
        const originalStageName = String(nodeConfig.stage_name || node.label || "").toLowerCase().trim();
        const matchingStage = (targetStages ?? []).find(
          (s) => s.name.toLowerCase().trim() === originalStageName,
        );

        if (matchingStage) {
          nodeConfig.pipeline_id = matchingStage.pipeline_id;
          nodeConfig.stage_id = matchingStage.id;
          delete nodeConfig.needs_review;
          warnings.push(
            `O nó «${node.label}» de mover etapa foi mapeado para a etapa correspondente «${matchingStage.name}».`,
          );
        } else {
          // Não reutilizar stage_id da organização de origem
          delete nodeConfig.pipeline_id;
          delete nodeConfig.stage_id;
          nodeConfig.needs_review = true;
          warnings.push(
            `O nó «${node.label}» de mover etapa foi marcado como pendente de revisão. Configure uma etapa da sua conta antes de publicar.`,
          );
        }
      }

      // Compatibilizar nós de tag
      if (node.type === "tag") {
        const rawTags = Array.isArray(nodeConfig.tags) ? nodeConfig.tags : [];
        const cleanTags = rawTags.map((t) => String(t).trim()).filter(Boolean);
        nodeConfig.tags = cleanTags;
        // As tags operam isoladas estritamente no escopo da organização de destino
      }

      // Compatibilizar nós de IA (ai_node) — isolamento cross-tenant estrito e normalização canônica
      if (node.type === "ai_node") {
        if (nodeConfig.agent_binding) {
          const binding = { ...(nodeConfig.agent_binding as Record<string, unknown>) };
          delete binding.agent_id;
          delete binding.pinned_version_id;
          delete (nodeConfig as Record<string, unknown>).agent_name;
          nodeConfig.agent_binding = binding;
          warnings.push(
            `O nó IA «${node.label}» requer a seleção de um agente da sua organização antes de publicar.`,
          );
        }
        const normalized = normalizeAiNodeTimeout(nodeConfig as any);
        nodeConfig.timeout = normalized.timeout;
        nodeConfig.timeout_ms = normalized.timeout_ms;
      }

      newNodes.push({
        id: newId,
        type: node.type,
        label: node.label,
        position: { x: node.position.x, y: node.position.y },
        config: nodeConfig,
      } as unknown as FlowNode);
    }

    // 4. Reconstruir arestas apontando para os novos IDs
    const newEdges: FlowEdge[] = (graph.edges ?? []).map((edge) => {
      const newSource = idMap.get(edge.source) ?? edge.source;
      const newTarget = idMap.get(edge.target) ?? edge.target;
      return {
        id: `edge-${randomUUID().slice(0, 8)}`,
        source: newSource,
        target: newTarget,
        priority: edge.priority ?? 0,
        condition: edge.condition,
      };
    });

    const newGraph: FlowGraph = {
      nodes: newNodes,
      edges: newEdges,
    };

    // 5. Inserir o novo fluxo em estado draft
    const { data: newPointer, error: insertErr } = await admin
      .from("followup_flow_pointers")
      .insert({
        organization_id: targetOrgId,
        name: uniqueName,
        status: "draft",
        draft_graph: newGraph,
        handoff_policy: handoffPolicy,
        trigger_config: triggerConfig,
      })
      .select("id, name")
      .single();

    if (insertErr || !newPointer) {
      logger.error("[importFlowIntoOrg] erro ao criar ponteiro do fluxo", {
        targetOrgId,
        error: insertErr?.message,
      });
      return {
        ok: false,
        error: insertErr?.message || "Falha ao gravar o novo fluxo importado.",
      };
    }

    // 6. Inserir versão inicial no histórico de versões
    const { error: versionErr } = await admin.from("followup_flow_versions").insert({
      organization_id: targetOrgId,
      pointer_id: newPointer.id,
      graph: newGraph,
      created_by: userId,
      label: "Versão 1 (Importada)",
      kind: "publish",
    });

    if (versionErr) {
      logger.warn("[importFlowIntoOrg] aviso ao gravar versão inicial do fluxo importado", {
        pointerId: newPointer.id,
        error: versionErr.message,
      });
    }

    return {
      ok: true,
      flow_id: newPointer.id,
      flow_name: newPointer.name,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("[importFlowIntoOrg] exceção inesperada durante importação", {
      targetOrgId,
      err: msg,
    });
    return { ok: false, error: msg };
  }
}

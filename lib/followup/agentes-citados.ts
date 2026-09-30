import type { SupabaseClient } from "@supabase/supabase-js";

import type { FlowNode } from "./graph-schema";

/**
 * Informações do agente citado em um nó de IA do grafo, resolvidas do banco.
 * Utilizado por validateFlowForPublish para conferir que o agente existe, pertence
 * à mesma organização, não está arquivado e possui versão publicada.
 */
export interface AgenteCitado {
  id: string;
  name: string;
  archived_at: string | null;
  published_version_id: string | null;
  version_ids: readonly string[];
}

/**
 * Extrai os ids de agentes e versões fixadas citados no grafo.
 */
export function idsDeAgentesCitados(nodes: readonly FlowNode[]): {
  agentIds: string[];
  pinnedVersionIds: string[];
} {
  const agentIds = new Set<string>();
  const pinnedVersionIds = new Set<string>();

  for (const node of nodes) {
    if (node.type !== "ai_node") continue;
    const binding = node.config.agent_binding;
    if (binding?.agent_id) {
      agentIds.add(binding.agent_id);
    }
    if (binding?.pinned_version_id) {
      pinnedVersionIds.add(binding.pinned_version_id);
    }
  }

  return {
    agentIds: [...agentIds],
    pinnedVersionIds: [...pinnedVersionIds],
  };
}

type AgentRow = {
  id: string;
  name: string;
  archived_at: string | null;
  published_version_id: string | null;
};

type VersionRow = {
  id: string;
  agent_id: string;
};

/**
 * Carrega os agentes e versões citados a partir da organização ativa.
 * NUNCA consulta registros de outra organização — RLS + filtro explícito por orgId.
 */
export async function carregaAgentesCitados(
  client: SupabaseClient,
  orgId: string,
  nodes: readonly FlowNode[],
): Promise<{ ok: true; agentes: Map<string, AgenteCitado> } | { ok: false; mensagem: string }> {
  const agentes = new Map<string, AgenteCitado>();
  const { agentIds, pinnedVersionIds } = idsDeAgentesCitados(nodes);

  if (agentIds.length === 0) return { ok: true, agentes };

  const { data: agentsData, error: agentsError } = await client
    .from("ai_agents")
    .select("id, name, archived_at, published_version_id")
    .eq("organization_id", orgId)
    .in("id", agentIds);

  if (agentsError) return { ok: false, mensagem: agentsError.message };

  const versionsByAgent = new Map<string, Set<string>>();
  if (pinnedVersionIds.length > 0) {
    const { data: versionsData, error: versionsError } = await client
      .from("ai_agent_versions")
      .select("id, agent_id")
      .eq("organization_id", orgId)
      .in("id", pinnedVersionIds);

    if (versionsError) return { ok: false, mensagem: versionsError.message };

    for (const v of (versionsData ?? []) as VersionRow[]) {
      const set = versionsByAgent.get(v.agent_id) ?? new Set<string>();
      set.add(v.id);
      versionsByAgent.set(v.agent_id, set);
    }
  }

  for (const a of (agentsData ?? []) as AgentRow[]) {
    const vSet = versionsByAgent.get(a.id) ?? new Set<string>();
    agentes.set(a.id, {
      id: a.id,
      name: a.name,
      archived_at: a.archived_at,
      published_version_id: a.published_version_id,
      version_ids: [...vSet],
    });
  }

  return { ok: true, agentes };
}

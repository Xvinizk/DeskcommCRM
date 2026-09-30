/**
 * Auditoria e Controle de Segurança de Tools MCP no Node IA (Fase 3).
 *
 * Princípio Fundamental:
 * O Fencing de banco (lease_generation) NÃO consegue desfazer efeitos colaterais
 * externos que já ocorreram no mundo real (ex.: envio WhatsApp, disparo de webhook,
 * alteração em CRM, agendamento de consulta, cobrança).
 *
 * Portanto, no Node IA V1:
 * 1. Modo custom_prompt opera com ZERO tools externas.
 * 2. Modos com agente existente (existing_agent e existing_with_supplementary):
 *    - SOMENTE ferramentas com categoria 'read' (read-only / sem efeito colateral)
 *      são permitidas, desde que já pertençam à configuração do agente.
 *    - TODAS as ferramentas com categoria 'write' ou 'handoff' (mutáveis) são
 *      bloqueadas sumariamente no Node IA para proteger a concorrência contra
 *      execuções zumbi (stale workers).
 */
import { catalogEntry, TOOL_CATALOG } from '@/lib/mcp/tools/catalog';
import type { McpToolCategory } from '@/lib/mcp/types';

export interface AiNodeToolAuditEntry {
  name: string;
  category: McpToolCategory;
  isReadOnly: boolean;
  isMutable: boolean;
  acceptsIdempotencyKey: boolean;
  safeUnderLease: boolean;
  statusNodeIa: 'allowed' | 'blocked';
  reason: string;
}

/**
 * Classifica formalmente a segurança de uma tool para execução sob o Node IA.
 */
export function classifyAiNodeTool(toolName: string): AiNodeToolAuditEntry {
  const entry = catalogEntry(toolName);
  const category = entry?.category ?? 'write';
  const isReadOnly = category === 'read';
  const isMutable = !isReadOnly;

  // No estado atual do CRM, ferramentas MCP não aceitam idempotency key do chamador
  const acceptsIdempotencyKey = false;

  // Ferramentas puramente read-only são seguras sob lease (não geram efeito externo irreversível)
  const safeUnderLease = isReadOnly;

  const statusNodeIa = isReadOnly ? 'allowed' : 'blocked';
  const reason = isReadOnly
    ? 'Operação idempotente de leitura (sem efeitos colaterais externos)'
    : 'Operação mutável com efeito colateral externo não compensável (bloqueada no Node IA Fase 3)';

  return {
    name: toolName,
    category,
    isReadOnly,
    isMutable,
    acceptsIdempotencyKey,
    safeUnderLease,
    statusNodeIa,
    reason,
  };
}

/**
 * Filtra a lista de toolIds configuradas em um agente, liberando apenas as
 * puramente read-only e bloqueando qualquer ferramenta com mutabilidade.
 */
export function filterAiNodeSafeTools(toolNames: readonly string[]): {
  safeToolNames: string[];
  blockedToolNames: string[];
  auditEntries: AiNodeToolAuditEntry[];
} {
  const safeToolNames: string[] = [];
  const blockedToolNames: string[] = [];
  const auditEntries: AiNodeToolAuditEntry[] = [];

  for (const name of toolNames) {
    const classification = classifyAiNodeTool(name);
    auditEntries.push(classification);
    if (classification.statusNodeIa === 'allowed') {
      safeToolNames.push(name);
    } else {
      blockedToolNames.push(name);
    }
  }

  return { safeToolNames, blockedToolNames, auditEntries };
}

/**
 * Inventário completo auditado do catálogo atual de ferramentas para documentação e governança.
 */
export function getFullAiNodeToolCatalogAudit(): AiNodeToolAuditEntry[] {
  return TOOL_CATALOG.map((entry) => classifyAiNodeTool(entry.name));
}

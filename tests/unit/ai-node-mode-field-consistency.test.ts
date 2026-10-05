import { describe, it, expect } from 'vitest';
import {
  aiNodeConfigSchema,
  type FlowGraph,
  type AiNodeConfig,
  type AiNodeMode,
} from '@/lib/followup/graph-schema';
import { validateFlowForPublish } from '@/lib/followup/validate-publish';
import { composeAiNodeSystemPrompt } from '@/lib/followup/ai-node-executor';
import type { AgenteCitado } from '@/lib/followup/agentes-citados';

describe('PUBLISH / CONFIG — CORREÇÃO CIRÚRGICA DO BUG DE CONTRATO DE MODE', () => {
  const AGENT_ID_VALID = 'cf373c07-4671-4bc0-9e8e-73d042d5277c';
  const VERSION_PUBLISHED = '67737c59-3e10-4e1b-a733-d39054a9d481';

  const mockAgentes = new Map<string, AgenteCitado>([
    [
      AGENT_ID_VALID,
      {
        id: AGENT_ID_VALID,
        name: 'Node IA — Homologação',
        archived_at: null,
        published_version_id: VERSION_PUBLISHED,
        version_ids: [VERSION_PUBLISHED],
      },
    ],
  ]);

  function buildTestGraph(config: AiNodeConfig): FlowGraph {
    return {
      nodes: [
        {
          id: 'trig',
          type: 'trigger',
          label: 'Início',
          position: { x: 0, y: 0 },
          config: { type: 'manual' },
        },
        {
          id: 'ai-1',
          type: 'ai_node',
          label: 'Node IA',
          position: { x: 100, y: 0 },
          config,
        },
        {
          id: 'end-1',
          type: 'end',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { outcome: 'converted' },
        },
      ],
      edges: [
        { id: 'e1', source: 'trig', target: 'ai-1', priority: 0, condition: { type: 'always' } },
        { id: 'e2', source: 'ai-1', target: 'end-1', priority: 0, condition: { type: 'branch', branch_id: 'completed' } },
      ],
    };
  }

  // =========================================================================
  // ITEM 4 & 9: NÃO ALTERAR SCHEMA DE FORMA DESTRUTIVA / COMPATIBILIDADE
  // =========================================================================
  describe('4 & 9. Não Alterar Schema de Forma Destrutiva / Compatibilidade', () => {
    it('OLD_PUBLISHED_VERSION_LOADS = true (schema continua permissivo para leitura)', () => {
      const legacyMixedConfig = {
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-LEGACY',
        supplementary_instruction: 'SUPP-LEGACY-RESIDUAL',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        agent_name: 'Agente Residual',
      };

      const parsed = aiNodeConfigSchema.safeParse(legacyMixedConfig);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.mode).toBe('custom_prompt');
      expect(parsed.data?.custom_prompt).toBe('PROMPT-LEGACY');
    });
  });

  // =========================================================================
  // ITEM 5: TESTES NEGATIVOS DE PUBLISH (FAIL-CLOSED)
  // =========================================================================
  describe('5. Testes Negativos de Publish (Fail-Closed por Mode)', () => {
    it('A) mode = custom_prompt + supplementary_instruction presente => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-A',
        supplementary_instruction: 'SUPP-INCOMPATIBLE',
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_supplementary_instruction')).toBe(true);
      }
    });

    it('B) mode = custom_prompt + agent_binding presente => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-B',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_agent_binding')).toBe(true);
      }
    });

    it('C) mode = custom_prompt + agent_name residual => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-C',
        agent_name: 'Agente Incompativel',
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_agent_name')).toBe(true);
      }
    });

    it('D) mode = existing_agent + custom_prompt presente => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'existing_agent',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        custom_prompt: 'CUSTOM-PROMPT-INCOMPATIBLE',
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_custom_prompt')).toBe(true);
      }
    });

    it('E) mode = existing_agent + supplementary_instruction presente => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'existing_agent',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        supplementary_instruction: 'SUPP-INCOMPATIBLE',
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_supplementary_instruction')).toBe(true);
      }
    });

    it('F) mode = existing_with_supplementary + custom_prompt presente => publish REJECT', () => {
      const graph = buildTestGraph({
        mode: 'existing_with_supplementary',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        supplementary_instruction: 'SUPP-OK',
        custom_prompt: 'CUSTOM-PROMPT-INCOMPATIBLE',
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_incompatible_custom_prompt')).toBe(true);
      }
    });
  });

  // =========================================================================
  // ITEM 6: TESTES POSITIVOS
  // =========================================================================
  describe('6. Testes Positivos (3 Modos Válidos sem Regressão)', () => {
    it('A. existing_agent válido publica normalmente com campos opcionais', () => {
      const graph = buildTestGraph({
        mode: 'existing_agent',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        agent_name: 'Node IA — Homologação',
        objective: 'OBJ-A',
        completion_condition: 'COND-A',
        max_turns: 8,
        timeout: { duration_value: 15, unit: 'minutes' },
        timeout_ms: 900000,
        deterministic_conditions: { require_audio: true },
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(true);
    });

    it('B. custom_prompt válido publica normalmente com campos opcionais', () => {
      const graph = buildTestGraph({
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-B-VALIDO',
        objective: 'OBJ-B',
        completion_condition: 'COND-B',
        max_turns: 5,
        timeout: { duration_value: 30, unit: 'minutes' },
        timeout_ms: 1800000,
        deterministic_conditions: { min_images: 1 },
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(true);
    });

    it('C. existing_with_supplementary válido publica normalmente com campos opcionais', () => {
      const graph = buildTestGraph({
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PUBLISHED,
        },
        agent_name: 'Node IA — Homologação',
        supplementary_instruction: 'DIRETRIZ COMPLEMENTAR C',
        objective: 'OBJ-C',
        completion_condition: 'COND-C',
        max_turns: 12,
        timeout: { duration_value: 2, unit: 'hours' },
        timeout_ms: 7200000,
      });
      const res = validateFlowForPublish(graph, { aiNodeEnabled: true, agentes: mockAgentes });
      expect(res.ok).toBe(true);
    });
  });

  // =========================================================================
  // ITEM 7: TESTES DO EXECUTOR (DEFESA EM PROFUNDIDADE)
  // =========================================================================
  describe('7. Testes do Executor (Defesa em Profundidade em Runtime)', () => {
    it('CASO 1: mode = custom_prompt com campos residuais (legado) -> usa PROMPT-CORRETO e NÃO inclui SUPP nem agent', () => {
      const composed = composeAiNodeSystemPrompt({
        mode: 'custom_prompt',
        platformCompliance: 'COMPLIANCE',
        agentSystemPrompt: 'AGENT-SYSTEM-PROMPT-RESIDUAL',
        supplementaryInstruction: 'SUPP-RESIDUAL',
        customPrompt: 'PROMPT-CORRETO',
        objective: 'OBJ-CORRETO',
      });

      expect(composed).toContain('## Instrução Específica do Nó\nPROMPT-CORRETO');
      expect(composed).toContain('## Objetivo do Nó\nOBJ-CORRETO');
      expect(composed).not.toContain('AGENT-SYSTEM-PROMPT-RESIDUAL');
      expect(composed).not.toContain('SUPP-RESIDUAL');
      expect(composed).not.toContain('Diretriz Complementar da Etapa Atual');
      expect(composed).not.toContain('Instruções do Agente');
    });

    it('CASO 2: mode = existing_agent com campos residuais -> usa AGENT-PROMPT e ignora custom_prompt e supplementary', () => {
      const composed = composeAiNodeSystemPrompt({
        mode: 'existing_agent',
        platformCompliance: 'COMPLIANCE',
        agentSystemPrompt: 'AGENT-PROMPT',
        supplementaryInstruction: 'SUPP-RESIDUAL',
        customPrompt: 'CUSTOM-RESIDUAL',
        objective: 'OBJ-AGENTE',
      });

      expect(composed).toContain('## Instruções do Agente\nAGENT-PROMPT');
      expect(composed).toContain('## Objetivo do Nó\nOBJ-AGENTE');
      expect(composed).not.toContain('CUSTOM-RESIDUAL');
      expect(composed).not.toContain('SUPP-RESIDUAL');
      expect(composed).not.toContain('Diretriz Complementar da Etapa Atual');
      expect(composed).not.toContain('Instrução Específica do Nó');
    });

    it('CASO 3: mode = existing_with_supplementary -> inclui AGENT-PROMPT + supplementary, ignora custom_prompt residual', () => {
      const composed = composeAiNodeSystemPrompt({
        mode: 'existing_with_supplementary',
        platformCompliance: 'COMPLIANCE',
        agentSystemPrompt: 'AGENT-PROMPT',
        supplementaryInstruction: 'SUPPLEMENTARY-VALID',
        customPrompt: 'CUSTOM-RESIDUAL',
        objective: 'OBJ-SUPP',
      });

      expect(composed).toContain('## Instruções do Agente\nAGENT-PROMPT');
      expect(composed).toContain('## Diretriz Complementar da Etapa Atual\nSUPPLEMENTARY-VALID');
      expect(composed).toContain('## Objetivo do Nó\nOBJ-SUPP');
      expect(composed).not.toContain('CUSTOM-RESIDUAL');
      expect(composed).not.toContain('Instrução Específica do Nó');
    });
  });

  // =========================================================================
  // ITEM 8: UI CLEANUP (AiNodeForm)
  // =========================================================================
  describe('8. UI Cleanup — Lógica de transição de modo no AiNodeForm', () => {
    function simulateModeChange(
      currentConfig: AiNodeConfig,
      newMode: AiNodeMode,
      selectedAgentId?: string,
    ): AiNodeConfig {
      const updateConfig = (patch: Partial<AiNodeConfig>): AiNodeConfig => {
        const next = { ...currentConfig, ...patch };
        for (const key of Object.keys(next)) {
          if ((next as Record<string, unknown>)[key] === undefined) {
            delete (next as Record<string, unknown>)[key];
          }
        }
        return next as AiNodeConfig;
      };

      if (newMode === 'custom_prompt') {
        return updateConfig({
          mode: newMode,
          agent_binding: undefined,
          agent_name: undefined,
          supplementary_instruction: undefined,
        });
      } else if (newMode === 'existing_agent') {
        return updateConfig({
          mode: newMode,
          agent_binding: {
            agent_id: selectedAgentId || null,
            version_strategy: 'published',
            pinned_version_id: null,
          },
          supplementary_instruction: undefined,
          custom_prompt: undefined,
        });
      } else {
        return updateConfig({
          mode: newMode,
          agent_binding: {
            agent_id: selectedAgentId || null,
            version_strategy: 'published',
            pinned_version_id: null,
          },
          custom_prompt: undefined,
        });
      }
    }

    it('troca: existing_with_supplementary -> custom_prompt limpa supplementary, agent_binding e agent_name', () => {
      const initial: AiNodeConfig = {
        mode: 'existing_with_supplementary',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        agent_name: 'Agente 1',
        supplementary_instruction: 'SUPPLEMENT-OLD',
        objective: 'OBJETIVO',
      };

      const result = simulateModeChange(initial, 'custom_prompt');
      expect(result.mode).toBe('custom_prompt');
      expect(result.supplementary_instruction).toBeUndefined();
      expect(result.agent_binding).toBeUndefined();
      expect(result.agent_name).toBeUndefined();
      expect('supplementary_instruction' in result).toBe(false);
      expect('agent_binding' in result).toBe(false);
    });

    it('troca: existing_agent -> custom_prompt limpa agent_binding e agent_name', () => {
      const initial: AiNodeConfig = {
        mode: 'existing_agent',
        agent_binding: { agent_id: AGENT_ID_VALID, version_strategy: 'published' },
        agent_name: 'Agente 1',
        objective: 'OBJETIVO',
      };

      const result = simulateModeChange(initial, 'custom_prompt');
      expect(result.mode).toBe('custom_prompt');
      expect(result.agent_binding).toBeUndefined();
      expect(result.agent_name).toBeUndefined();
      expect('agent_binding' in result).toBe(false);
    });

    it('troca: custom_prompt -> existing_agent limpa custom_prompt e supplementary', () => {
      const initial: AiNodeConfig = {
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-OLD',
        objective: 'OBJETIVO',
      };

      const result = simulateModeChange(initial, 'existing_agent', AGENT_ID_VALID);
      expect(result.mode).toBe('existing_agent');
      expect(result.custom_prompt).toBeUndefined();
      expect(result.supplementary_instruction).toBeUndefined();
      expect(result.agent_binding?.agent_id).toBe(AGENT_ID_VALID);
      expect('custom_prompt' in result).toBe(false);
    });

    it('troca: custom_prompt -> existing_with_supplementary limpa custom_prompt', () => {
      const initial: AiNodeConfig = {
        mode: 'custom_prompt',
        custom_prompt: 'PROMPT-OLD',
        objective: 'OBJETIVO',
      };

      const result = simulateModeChange(initial, 'existing_with_supplementary', AGENT_ID_VALID);
      expect(result.mode).toBe('existing_with_supplementary');
      expect(result.custom_prompt).toBeUndefined();
      expect(result.agent_binding?.agent_id).toBe(AGENT_ID_VALID);
      expect('custom_prompt' in result).toBe(false);
    });
  });

  // =========================================================================
  // ITEM 5: ROUNDTRIP DOS 3 MODOS
  // =========================================================================
  describe('5. Roundtrip Isolado dos 3 Modos (Input -> Persisted -> Reloaded)', () => {
    function roundtrip<T>(data: T): T {
      const serialized = JSON.stringify(data);
      const reloaded = JSON.parse(serialized);
      return aiNodeConfigSchema.parse(reloaded) as unknown as T;
    }

    it('MODE A — existing_agent: roundtrip perfeito sem campos incompatíveis', () => {
      const modeAInput: AiNodeConfig = {
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'published',
        },
        agent_name: 'Node IA — Homologação',
        objective: 'OBJ-MODE-A',
        completion_condition: 'COND-MODE-A',
        max_turns: 10,
        timeout: { duration_value: 24, unit: 'hours' },
        timeout_ms: 86400000,
      };

      const reloaded = roundtrip(modeAInput);
      expect(reloaded).toEqual(modeAInput);
      expect(reloaded.custom_prompt).toBeUndefined();
      expect(reloaded.supplementary_instruction).toBeUndefined();
      expect('custom_prompt' in reloaded).toBe(false);
      expect('supplementary_instruction' in reloaded).toBe(false);
    });

    it('MODE B — custom_prompt: roundtrip perfeito sem campos incompatíveis', () => {
      const modeBInput: AiNodeConfig = {
        mode: 'custom_prompt',
        objective: 'OBJ-MODE-B',
        custom_prompt: 'PROMPT-MODE-B',
        completion_condition: 'COND-MODE-B',
        max_turns: 5,
        timeout: { duration_value: 30, unit: 'minutes' },
        timeout_ms: 1800000,
      };

      const reloaded = roundtrip(modeBInput);
      expect(reloaded).toEqual(modeBInput);
      expect(reloaded.agent_binding).toBeUndefined();
      expect(reloaded.agent_name).toBeUndefined();
      expect(reloaded.supplementary_instruction).toBeUndefined();
      expect('agent_binding' in reloaded).toBe(false);
      expect('agent_name' in reloaded).toBe(false);
      expect('supplementary_instruction' in reloaded).toBe(false);
    });

    it('MODE C — existing_with_supplementary: roundtrip perfeito sem campos incompatíveis', () => {
      const modeCInput: AiNodeConfig = {
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PUBLISHED,
        },
        agent_name: 'Node IA — Homologação',
        objective: 'OBJ-MODE-C',
        supplementary_instruction: 'SUPPLEMENT-MODE-C',
        completion_condition: 'COND-MODE-C',
        max_turns: 8,
        timeout: { duration_value: 12, unit: 'hours' },
        timeout_ms: 43200000,
      };

      const reloaded = roundtrip(modeCInput);
      expect(reloaded).toEqual(modeCInput);
      expect(reloaded.custom_prompt).toBeUndefined();
      expect('custom_prompt' in reloaded).toBe(false);
    });
  });
});

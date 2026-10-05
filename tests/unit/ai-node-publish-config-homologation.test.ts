import { describe, it, expect } from 'vitest';
import {
  aiNodeConfigSchema,
  nodeBranches,
  normalizeAiNodeTimeout,
  AI_NODE_COMPLETED_BRANCH_ID,
  AI_NODE_TIMEOUT_BRANCH_ID,
  AI_NODE_MAX_TURNS_BRANCH_ID,
  AI_NODE_HANDOFF_BRANCH_ID,
  AI_NODE_ERROR_BRANCH_ID,
  type FlowGraph,
  type FlowNode,
  type AiNodeConfig,
} from '@/lib/followup/graph-schema';
import { validateFlowForPublish } from '@/lib/followup/validate-publish';
import type { AgenteCitado } from '@/lib/followup/agentes-citados';

describe('HOMOLOGAÇÃO: PUBLISH / CONFIG — NODE IA', () => {
  const _TEST_ORG_ID = '56313621-8d2e-4682-b087-743c77e8aaca';
  const AGENT_ID_VALID = 'cf373c07-4671-4bc0-9e8e-73d042d5277c';
  const AGENT_ID_ARCHIVED = '22222222-2222-4222-8222-222222222222';
  const AGENT_ID_UNPUBLISHED = '33333333-3333-4333-8333-333333333333';
  const AGENT_ID_CROSS_TENANT = '99999999-9999-4999-8999-999999999999';

  const VERSION_PUBLISHED = '67737c59-3e10-4e1b-a733-d39054a9d481';
  const VERSION_PINNED_VALID = '67737c59-3e10-4e1b-a733-d39054a9d481';
  const VERSION_PINNED_INVALID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
    [
      AGENT_ID_ARCHIVED,
      {
        id: AGENT_ID_ARCHIVED,
        name: 'Agente Arquivado',
        archived_at: '2026-10-01T00:00:00Z',
        published_version_id: VERSION_PUBLISHED,
        version_ids: [VERSION_PUBLISHED],
      },
    ],
    [
      AGENT_ID_UNPUBLISHED,
      {
        id: AGENT_ID_UNPUBLISHED,
        name: 'Agente Sem Versão Publicada',
        archived_at: null,
        published_version_id: null,
        version_ids: [],
      },
    ],
  ]);

  function makeFlowGraph(aiConfig: AiNodeConfig): FlowGraph {
    return {
      nodes: [
        {
          id: 'trigger-1',
          type: 'trigger',
          label: 'Gatilho',
          position: { x: 0, y: 0 },
          config: { type: 'manual' },
        },
        {
          id: 'node-ai-1',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 100, y: 100 },
          config: aiConfig,
        },
        {
          id: 'end-completed',
          type: 'end',
          label: 'Fim Concluído',
          position: { x: 300, y: 0 },
          config: { outcome: 'converted' },
        },
        {
          id: 'end-timeout',
          type: 'end',
          label: 'Fim Timeout',
          position: { x: 300, y: 100 },
          config: { outcome: 'exhausted' },
        },
      ],
      edges: [
        {
          id: 'e-in',
          source: 'trigger-1',
          target: 'node-ai-1',
          priority: 0,
          condition: { type: 'always' },
        },
        {
          id: 'e-completed',
          source: 'node-ai-1',
          target: 'end-completed',
          priority: 0,
          condition: { type: 'branch', branch_id: AI_NODE_COMPLETED_BRANCH_ID },
        },
        {
          id: 'e-timeout',
          source: 'node-ai-1',
          target: 'end-timeout',
          priority: 0,
          condition: { type: 'branch', branch_id: AI_NODE_TIMEOUT_BRANCH_ID },
        },
      ],
    };
  }

  // =========================================================================
  // 1. MAPEAR O CONTRATO COMPLETO DO NODE IA
  // =========================================================================
  describe('1. Contrato e Schema do ai_node', () => {
    it('valida todos os campos suportados no contrato do aiNodeConfigSchema', () => {
      const fullConfig: AiNodeConfig = {
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_VALID,
        },
        agent_name: 'Node IA — Homologação',
        objective: 'QUALIFICAR LEAD 1026',
        supplementary_instruction: 'DIRETRIZ COMPLEMENTAR 1026',
        custom_prompt: undefined,
        completion_condition: 'cliente_respondeu_sim',
        max_turns: 8,
        timeout: { duration_value: 15, unit: 'minutes' },
        timeout_ms: 900_000,
        deterministic_conditions: {
          min_images: 2,
          require_audio: true,
          require_document: false,
          tag_exists: 'vip',
        },
      };

      const parsed = aiNodeConfigSchema.safeParse(fullConfig);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mode).toBe('existing_with_supplementary');
        expect(parsed.data.agent_binding?.agent_id).toBe(AGENT_ID_VALID);
        expect(parsed.data.agent_binding?.version_strategy).toBe('pinned');
        expect(parsed.data.agent_binding?.pinned_version_id).toBe(VERSION_PINNED_VALID);
        expect(parsed.data.agent_name).toBe('Node IA — Homologação');
        expect(parsed.data.objective).toBe('QUALIFICAR LEAD 1026');
        expect(parsed.data.supplementary_instruction).toBe('DIRETRIZ COMPLEMENTAR 1026');
        expect(parsed.data.max_turns).toBe(8);
        expect(parsed.data.timeout).toEqual({ duration_value: 15, unit: 'minutes' });
        expect(parsed.data.timeout_ms).toBe(900_000);
      }
    });

    it('confirma branches canônicas reservadas do ai_node', () => {
      const node: FlowNode = {
        id: 'ai-node',
        type: 'ai_node',
        label: 'Node IA',
        position: { x: 0, y: 0 },
        config: {
          mode: 'custom_prompt',
          objective: 'Objetivo',
        },
      };

      const branches = nodeBranches(node);
      expect(branches).toHaveLength(5);
      expect(branches.map((b) => b.id)).toEqual([
        AI_NODE_COMPLETED_BRANCH_ID,
        AI_NODE_TIMEOUT_BRANCH_ID,
        AI_NODE_MAX_TURNS_BRANCH_ID,
        AI_NODE_HANDOFF_BRANCH_ID,
        AI_NODE_ERROR_BRANCH_ID,
      ]);
    });
  });

  // =========================================================================
  // 2. AUDITAR OS 3 MODOS
  // =========================================================================
  describe('2. Auditoria dos 3 Modos', () => {
    it('Mode A: existing_agent com version_strategy published', () => {
      const modeAConfig: AiNodeConfig = {
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'published',
        },
        max_turns: 10,
        timeout: { duration_value: 24, unit: 'hours' },
      };

      const parsed = aiNodeConfigSchema.safeParse(modeAConfig);
      expect(parsed.success).toBe(true);

      const graph = makeFlowGraph(modeAConfig);
      const val = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });
      expect(val.ok).toBe(true);
    });

    it('Mode B: custom_prompt com objective e custom_prompt', () => {
      const modeBConfig: AiNodeConfig = {
        mode: 'custom_prompt',
        objective: 'OBJETIVO-CUSTOM-PROMPT',
        custom_prompt: 'PROMPT-AUTONOMO-1026',
        max_turns: 5,
        timeout: { duration_value: 30, unit: 'minutes' },
      };

      const parsed = aiNodeConfigSchema.safeParse(modeBConfig);
      expect(parsed.success).toBe(true);

      const graph = makeFlowGraph(modeBConfig);
      const val = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });
      expect(val.ok).toBe(true);
    });

    it('Mode C: existing_agent_with_supplementary_instruction', () => {
      const modeCConfig: AiNodeConfig = {
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_VALID,
        },
        supplementary_instruction: 'DIRETRIZ DE ETAPA',
        objective: 'OBJETIVO DA ETAPA',
        max_turns: 12,
        timeout: { duration_value: 2, unit: 'days' },
      };

      const parsed = aiNodeConfigSchema.safeParse(modeCConfig);
      expect(parsed.success).toBe(true);

      const graph = makeFlowGraph(modeCConfig);
      const val = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });
      expect(val.ok).toBe(true);
    });
  });

  // =========================================================================
  // 3 & 4. UI -> CONFIG & SERIALIZAÇÃO / DESERIALIZAÇÃO ROUNDTRIP
  // =========================================================================
  describe('3 e 4. Config Roundtrip e Serialização', () => {
    it('garante roundtrip exato (JSON parse -> normalize -> JSON stringify) sem perda de campos', () => {
      const inputConfig: AiNodeConfig = {
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_VALID,
        },
        agent_name: 'Node IA — Homologação',
        objective: 'OBJ-ROUNDTRIP-1026',
        supplementary_instruction: 'SUPP-ROUNDTRIP-1026',
        completion_condition: 'CONCLUSAO-ROUNDTRIP-1026',
        max_turns: 7,
        timeout: { duration_value: 45, unit: 'minutes' },
        deterministic_conditions: {
          min_images: 1,
          require_audio: true,
        },
      };

      // 1. Simula salvamento no banco como JSON
      const serializedDraft = JSON.stringify(inputConfig);

      // 2. Simula reload do banco
      const reloadedJson = JSON.parse(serializedDraft);

      // 3. Normalização canônica
      const normalized = normalizeAiNodeTimeout(aiNodeConfigSchema.parse(reloadedJson));

      // 4. Verificação de igualdade campo a campo
      expect(normalized.mode).toBe(inputConfig.mode);
      expect(normalized.agent_binding).toEqual(inputConfig.agent_binding);
      expect(normalized.agent_name).toBe(inputConfig.agent_name);
      expect(normalized.objective).toBe(inputConfig.objective);
      expect(normalized.supplementary_instruction).toBe(inputConfig.supplementary_instruction);
      expect(normalized.completion_condition).toBe(inputConfig.completion_condition);
      expect(normalized.max_turns).toBe(inputConfig.max_turns);
      expect(normalized.timeout).toEqual(inputConfig.timeout);
      expect(normalized.timeout_ms).toBe(45 * 60_000);
      expect(normalized.deterministic_conditions).toEqual(inputConfig.deterministic_conditions);
    });

    it('normaliza timeout legado com timeout_ms derivando duration_value e unit', () => {
      const legacyConfig = {
        mode: 'custom_prompt' as const,
        objective: 'Objetivo',
        timeout_ms: 7_200_000, // 2 horas
      };

      const normalized = normalizeAiNodeTimeout(legacyConfig);
      expect(normalized.timeout).toEqual({ duration_value: 2, unit: 'hours' });
      expect(normalized.timeout_ms).toBe(7_200_000);
    });
  });

  // =========================================================================
  // 5. VALIDATE FOR PUBLISH — TESTES POSITIVOS E NEGATIVOS
  // =========================================================================
  describe('5. validateFlowForPublish — Casos Positivos e Negativos Controlados', () => {
    it('NEGATIVO 1: custom_prompt sem objective e sem custom_prompt -> ai_node_missing_instruction', () => {
      const graph = makeFlowGraph({
        mode: 'custom_prompt',
        objective: '',
        custom_prompt: '   ',
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_missing_instruction')).toBe(true);
      }
    });

    it('NEGATIVO 2: existing_agent sem agent_id -> ai_node_agent_not_found', () => {
      const graph = makeFlowGraph({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: null,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_agent_not_found')).toBe(true);
      }
    });

    it('NEGATIVO 3: existing_agent referenciando agente de outra organização (cross-tenant) -> ai_node_agent_not_found', () => {
      const graph = makeFlowGraph({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_CROSS_TENANT,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_agent_not_found')).toBe(true);
      }
    });

    it('NEGATIVO 4: existing_agent com agente arquivado -> ai_node_agent_archived', () => {
      const graph = makeFlowGraph({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_ARCHIVED,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_agent_archived')).toBe(true);
      }
    });

    it('NEGATIVO 5: existing_agent com agente sem versão publicada -> ai_node_agent_unpublished', () => {
      const graph = makeFlowGraph({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_UNPUBLISHED,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_agent_unpublished')).toBe(true);
      }
    });

    it('NEGATIVO 6: pinned_version_id que não pertence ao agente -> ai_node_pinned_version_invalid', () => {
      const graph = makeFlowGraph({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_INVALID,
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'ai_node_pinned_version_invalid')).toBe(true);
      }
    });

    it('NEGATIVO 7: feature flag desativada (aiNodeEnabled=false) -> feature_disabled', () => {
      const graph = makeFlowGraph({
        mode: 'custom_prompt',
        objective: 'Objetivo',
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: false,
        agentes: mockAgentes,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.some((e) => e.code === 'feature_disabled')).toBe(true);
      }
    });

    it('NEGATIVO 8: max_turns e timeout inválidos no schema', () => {
      expect(
        aiNodeConfigSchema.safeParse({
          mode: 'custom_prompt',
          objective: 'Ok',
          max_turns: -1,
        }).success,
      ).toBe(false);

      expect(
        aiNodeConfigSchema.safeParse({
          mode: 'custom_prompt',
          objective: 'Ok',
          timeout: { duration_value: 0, unit: 'hours' },
        }).success,
      ).toBe(false);
    });
  });

  // =========================================================================
  // 14. LEGACY FLOW REGRESSION
  // =========================================================================
  describe('14. Não-Regressão de Fluxos Legados', () => {
    it('fluxo legado sem ai_node valida com sucesso mesmo se aiNodeEnabled for false', () => {
      const legacyGraph: FlowGraph = {
        nodes: [
          {
            id: 'trig',
            type: 'trigger',
            label: 'Trigger',
            position: { x: 0, y: 0 },
            config: { type: 'manual' },
          },
          {
            id: 'wait1',
            type: 'wait',
            label: 'Espera 10m',
            position: { x: 100, y: 0 },
            config: { mode: 'fixed', duration_ms: 600_000 },
          },
          {
            id: 'msg1',
            type: 'message_text',
            label: 'Mensagem',
            position: { x: 200, y: 0 },
            config: { body: 'Olá mundo' },
          },
          {
            id: 'end1',
            type: 'end',
            label: 'Fim',
            position: { x: 300, y: 0 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'wait1', priority: 0, condition: { type: 'always' } },
          { id: 'e2', source: 'wait1', target: 'msg1', priority: 0, condition: { type: 'always' } },
          { id: 'e3', source: 'msg1', target: 'end1', priority: 0, condition: { type: 'always' } },
        ],
      };

      const res = validateFlowForPublish(legacyGraph, {
        aiNodeEnabled: false,
      });

      expect(res.ok).toBe(true);
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from '@/lib/followup/graph-schema';
import { validateFlowForPublish } from '@/lib/followup/validate-publish';
import type { AgenteCitado } from '@/lib/followup/agentes-citados';

describe('ai_node — Validações de Publicação (Fase 1)', () => {
  const AGENT_ID_VALID = '11111111-1111-4111-8111-111111111111';
  const AGENT_ID_ARCHIVED = '22222222-2222-4222-8222-222222222222';
  const AGENT_ID_UNPUBLISHED = '33333333-3333-4333-8333-333333333333';
  const AGENT_ID_CROSS_TENANT = '44444444-4444-4444-8444-444444444444';

  const VERSION_PUBLISHED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const VERSION_PINNED_VALID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const VERSION_PINNED_INVALID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  // Mock de agentes resolvidos pelo banco da org (carregaAgentesCitados)
  const agentesMap = new Map<string, AgenteCitado>([
    [
      AGENT_ID_VALID,
      {
        id: AGENT_ID_VALID,
        name: 'Agente Ativo',
        archived_at: null,
        published_version_id: VERSION_PUBLISHED,
        version_ids: [VERSION_PUBLISHED, VERSION_PINNED_VALID],
      },
    ],
    [
      AGENT_ID_ARCHIVED,
      {
        id: AGENT_ID_ARCHIVED,
        name: 'Agente Arquivado',
        archived_at: '2026-09-01T10:00:00.000Z',
        published_version_id: VERSION_PUBLISHED,
        version_ids: [VERSION_PUBLISHED],
      },
    ],
    [
      AGENT_ID_UNPUBLISHED,
      {
        id: AGENT_ID_UNPUBLISHED,
        name: 'Agente Em Rascunho',
        archived_at: null,
        published_version_id: null,
        version_ids: [],
      },
    ],
  ]);

  function buildGraphWithAiNode(aiNodeConfig: Extract<FlowNode, { type: 'ai_node' }>['config']): FlowGraph {
    return {
      nodes: [
        {
          id: 'node-trigger',
          type: 'trigger',
          label: 'Início',
          position: { x: 0, y: 0 },
          config: { type: 'manual' },
        },
        {
          id: 'node-ai',
          type: 'ai_node',
          label: 'Atendimento IA',
          position: { x: 100, y: 0 },
          config: aiNodeConfig,
        },
        {
          id: 'node-end',
          type: 'end',
          label: 'Fim',
          position: { x: 200, y: 0 },
          config: { outcome: 'converted' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'node-trigger',
          target: 'node-ai',
          priority: 1,
          condition: { type: 'always' },
        },
        {
          id: 'e2',
          source: 'node-ai',
          target: 'node-end',
          priority: 1,
          condition: { type: 'branch', branch_id: 'completed' },
        },
      ],
    };
  }

  describe('1. Feature Flag = false (ou omitida)', () => {
    it('rejeita publicação de fluxo contendo ai_node com código feature_disabled', () => {
      const graph = buildGraphWithAiNode({
        mode: 'custom_prompt',
        objective: 'Atender lead',
      });

      // aiNodeEnabled: false
      const resFalse = validateFlowForPublish(graph, {
        aiNodeEnabled: false,
        agentes: agentesMap,
      });
      expect(resFalse.ok).toBe(false);
      if (!resFalse.ok) {
        expect(resFalse.errors).toHaveLength(1);
        expect(resFalse.errors[0]?.code).toBe('feature_disabled');
        expect(resFalse.errors[0]?.node_id).toBe('node-ai');
      }

      // aiNodeEnabled omitido (default false)
      const resOmitted = validateFlowForPublish(graph, {
        agentes: agentesMap,
      });
      expect(resOmitted.ok).toBe(false);
      if (!resOmitted.ok) {
        expect(resOmitted.errors[0]?.code).toBe('feature_disabled');
      }
    });
  });

  describe('2. Feature Flag = true: Validação de Agente e Tenancy', () => {
    it('aprova ai_node no modo existing_agent com agente válido e publicado', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(true);
    });

    it('aprova ai_node no modo custom_prompt', () => {
      const graph = buildGraphWithAiNode({
        mode: 'custom_prompt',
        objective: 'Qualificar lead comercial',
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(true);
    });

    it('aprova ai_node no modo existing_with_supplementary com pinned_version válida', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_VALID,
        },
        supplementary_instruction: 'Instrução complementar válida',
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(true);
    });

    it('rejeita quando agent_id não existe ou pertence a outra organização (cross-tenant)', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_CROSS_TENANT, // Não está no mapa de agentes da org
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe('ai_node_agent_not_found');
        expect(res.errors[0]?.node_id).toBe('node-ai');
      }
    });

    it('rejeita quando o agente selecionado está arquivado', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_ARCHIVED,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe('ai_node_agent_archived');
        expect(res.errors[0]?.message).toContain('arquivado');
      }
    });

    it('rejeita quando o agente selecionado não possui versão publicada', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: AGENT_ID_UNPUBLISHED,
          version_strategy: 'published',
        },
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe('ai_node_agent_unpublished');
        expect(res.errors[0]?.message).toContain('não possui versão publicada');
      }
    });

    it('rejeita quando a pinned_version_id não pertence ao agente', () => {
      const graph = buildGraphWithAiNode({
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: AGENT_ID_VALID,
          version_strategy: 'pinned',
          pinned_version_id: VERSION_PINNED_INVALID, // Não está em version_ids do agente
        },
        supplementary_instruction: 'Instrução',
      });

      const res = validateFlowForPublish(graph, {
        aiNodeEnabled: true,
        agentes: agentesMap,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]?.code).toBe('ai_node_pinned_version_invalid');
        expect(res.errors[0]?.message).toContain('Versão fixada');
      }
    });
  });

  describe('3. Compatibilidade com fluxos legados e outros nós', () => {
    it('publica fluxos legados normalmente mesmo com feature flag false', () => {
      const legacyGraph: FlowGraph = {
        nodes: [
          {
            id: 'n-trigger',
            type: 'trigger',
            label: 'Início',
            position: { x: 0, y: 0 },
            config: { type: 'manual' },
          },
          {
            id: 'n-wait',
            type: 'wait',
            label: 'Espera 10m',
            position: { x: 100, y: 0 },
            config: { mode: 'fixed', duration_ms: 600_000 },
          },
          {
            id: 'n-end',
            type: 'end',
            label: 'Fim',
            position: { x: 200, y: 0 },
            config: { outcome: 'converted' },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'n-trigger',
            target: 'n-wait',
            priority: 1,
            condition: { type: 'always' },
          },
          {
            id: 'e2',
            source: 'n-wait',
            target: 'n-end',
            priority: 1,
            condition: { type: 'always' },
          },
        ],
      };

      const res = validateFlowForPublish(legacyGraph, {
        aiNodeEnabled: false,
      });
      expect(res.ok).toBe(true);
    });
  });
});

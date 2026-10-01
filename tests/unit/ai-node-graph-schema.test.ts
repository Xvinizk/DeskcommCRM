import { describe, expect, it } from 'vitest';
import {
  aiNodeConfigSchema,
  flowNodeSchema,
  flowGraphSchema,
  nodeBranches,
  isReservedBranchId,
  AI_NODE_COMPLETED_BRANCH_ID,
  AI_NODE_TIMEOUT_BRANCH_ID,
  AI_NODE_MAX_TURNS_BRANCH_ID,
  AI_NODE_HANDOFF_BRANCH_ID,
  AI_NODE_ERROR_BRANCH_ID,
  type FlowNode,
  type FlowGraph,
} from '@/lib/followup/graph-schema';

describe('ai_node — Graph Schema (Fase 1)', () => {
  const VALID_AGENT_ID = '123e4567-e89b-12d3-a456-426614174000';
  const VALID_PINNED_VERSION_ID = '987fcdeb-51a2-43f7-9876-ba0987654321';

  describe('1. Três modos válidos', () => {
    it('suporta modo existing_agent com version_strategy published', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: VALID_AGENT_ID,
          version_strategy: 'published',
        },
        max_turns: 5,
        timeout: { duration_value: 30, unit: 'minutes' },
        completion_condition: 'agendou_reuniao',
        deterministic_conditions: [
          { intent: 'fechou', target_branch: 'completed' },
        ],
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mode).toBe('existing_agent');
        expect(parsed.data.agent_binding?.agent_id).toBe(VALID_AGENT_ID);
        expect(parsed.data.agent_binding?.version_strategy).toBe('published');
        expect(parsed.data.max_turns).toBe(5);
        expect(parsed.data.timeout?.duration_value).toBe(30);
      }
    });

    it('suporta modo custom_prompt com objective', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: 'Qualificar lead para o produto X e responder dúvidas técnicas.',
        max_turns: 3,
        timeout: { duration_value: 2, unit: 'hours' },
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mode).toBe('custom_prompt');
        expect(parsed.data.objective).toBe('Qualificar lead para o produto X e responder dúvidas técnicas.');
        expect(parsed.data.max_turns).toBe(3);
        expect(parsed.data.agent_binding).toBeUndefined();
      }
    });

    it('suporta modo existing_with_supplementary com pinned_version_id', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'existing_with_supplementary',
        agent_binding: {
          agent_id: VALID_AGENT_ID,
          version_strategy: 'pinned',
          pinned_version_id: VALID_PINNED_VERSION_ID,
        },
        supplementary_instruction: 'Ofereça 15% de desconto apenas se o cliente hesitar pelo preço.',
        objective: 'Recuperar lead inativo',
        max_turns: 8,
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mode).toBe('existing_with_supplementary');
        expect(parsed.data.agent_binding?.pinned_version_id).toBe(VALID_PINNED_VERSION_ID);
        expect(parsed.data.supplementary_instruction).toContain('15% de desconto');
      }
    });
  });

  describe('2. Configurações inválidas ou incompletas', () => {
    it('permite existing_agent em draft mesmo antes de selecionar agent_binding (validação estrita ocorre no publish)', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'existing_agent',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejeita existing_agent com agent_id inválido (não UUID)', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: 'not-a-uuid',
          version_strategy: 'published',
        },
      });
      expect(parsed.success).toBe(false);
    });

    it('permite version_strategy pinned em draft com pinned_version_id pendente (validação estrita ocorre no publish)', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'existing_agent',
        agent_binding: {
          agent_id: VALID_AGENT_ID,
          version_strategy: 'pinned',
        },
      });
      expect(parsed.success).toBe(true);
    });

    it('permite custom_prompt em draft com objective/prompt ainda em edição (validação estrita ocorre no publish)', () => {
      const parsed = aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: '',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejeita max_turns menor que 1 ou maior que 100', () => {
      expect(aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: 'teste',
        max_turns: 0,
      }).success).toBe(false);

      expect(aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: 'teste',
        max_turns: 101,
      }).success).toBe(false);
    });

    it('rejeita timeout inválido', () => {
      expect(aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: 'teste',
        timeout: { duration_value: 0, unit: 'minutes' },
      }).success).toBe(false);

      expect(aiNodeConfigSchema.safeParse({
        mode: 'custom_prompt',
        objective: 'teste',
        timeout: { duration_value: 5, unit: 'centuries' as unknown as 'minutes' },
      }).success).toBe(false);
    });
  });

  describe('3. Nó no flowNodeSchema', () => {
    it('valida nó completo do tipo ai_node', () => {
      const node: FlowNode = {
        id: 'ai-node-1',
        type: 'ai_node',
        label: 'Atendimento IA Comercial',
        position: { x: 100, y: 200 },
        config: {
          mode: 'existing_agent',
          agent_binding: {
            agent_id: VALID_AGENT_ID,
            version_strategy: 'published',
          },
          max_turns: 5,
        },
      };

      const parsed = flowNodeSchema.safeParse(node);
      expect(parsed.success).toBe(true);
    });
  });

  describe('4. Branches reservadas do ai_node', () => {
    const aiNode: FlowNode = {
      id: 'ai-node-1',
      type: 'ai_node',
      label: 'Qualificador',
      position: { x: 0, y: 0 },
      config: {
        mode: 'custom_prompt',
        objective: 'Qualificar lead',
      },
    };

    it('retorna exatamente as 5 branches canônicas', () => {
      const branches = nodeBranches(aiNode);
      expect(branches).toHaveLength(5);

      const branchIds = branches.map((b) => b.id);
      expect(branchIds).toEqual([
        AI_NODE_COMPLETED_BRANCH_ID,
        AI_NODE_TIMEOUT_BRANCH_ID,
        AI_NODE_MAX_TURNS_BRANCH_ID,
        AI_NODE_HANDOFF_BRANCH_ID,
        AI_NODE_ERROR_BRANCH_ID,
      ]);

      // 4 branches regulares + 1 fallback (error)
      expect(branches.find((b) => b.id === AI_NODE_COMPLETED_BRANCH_ID)?.kind).toBe('match');
      expect(branches.find((b) => b.id === AI_NODE_TIMEOUT_BRANCH_ID)?.kind).toBe('match');
      expect(branches.find((b) => b.id === AI_NODE_MAX_TURNS_BRANCH_ID)?.kind).toBe('match');
      expect(branches.find((b) => b.id === AI_NODE_HANDOFF_BRANCH_ID)?.kind).toBe('match');
      expect(branches.find((b) => b.id === AI_NODE_ERROR_BRANCH_ID)?.kind).toBe('fallback');
    });

    it('isReservedBranchId identifica as branches do ai_node', () => {
      expect(isReservedBranchId(AI_NODE_COMPLETED_BRANCH_ID)).toBe(true);
      expect(isReservedBranchId(AI_NODE_TIMEOUT_BRANCH_ID)).toBe(true);
      expect(isReservedBranchId(AI_NODE_MAX_TURNS_BRANCH_ID)).toBe(true);
      expect(isReservedBranchId(AI_NODE_HANDOFF_BRANCH_ID)).toBe(true);
      expect(isReservedBranchId(AI_NODE_ERROR_BRANCH_ID)).toBe(true);
      expect(isReservedBranchId('custom_random_branch')).toBe(false);
    });
  });

  describe('5. Não-regressão: Grafos e nós existentes continuam funcionando', () => {
    it('parseia grafo com trigger, wait, action e end sem ai_node', () => {
      const legacyGraph: FlowGraph = {
        nodes: [
          { id: 'node-trigger', type: 'trigger', label: 'Início', position: { x: 0, y: 0 }, config: { type: 'manual' } },
          { id: 'node-wait', type: 'wait', label: 'Espera', position: { x: 100, y: 0 }, config: { mode: 'fixed', duration_ms: 600_000 } },
          { id: 'node-action', type: 'action', label: 'Ação', position: { x: 200, y: 0 }, config: { mode: 'template', template_id: VALID_AGENT_ID } },
          { id: 'node-end', type: 'end', label: 'Fim', position: { x: 300, y: 0 }, config: { outcome: 'converted' } },
        ],
        edges: [
          { id: 'e1', source: 'node-trigger', target: 'node-wait', priority: 1, condition: { type: 'always' } },
          { id: 'e2', source: 'node-wait', target: 'node-action', priority: 1, condition: { type: 'always' } },
          { id: 'e3', source: 'node-action', target: 'node-end', priority: 1, condition: { type: 'always' } },
        ],
      };

      const parsed = flowGraphSchema.safeParse(legacyGraph);
      expect(parsed.success).toBe(true);
    });

    it('parseia grafo v2 com novos nós (message_text, delay, typing, stage_move)', () => {
      const v2Graph: FlowGraph = {
        nodes: [
          { id: 't1', type: 'trigger', label: 'Gatilho', position: { x: 0, y: 0 }, config: { type: 'manual' } },
          { id: 'm1', type: 'message_text', label: 'Texto', position: { x: 100, y: 0 }, config: { body: 'Olá' } },
          { id: 'd1', type: 'delay', label: 'Delay', position: { x: 200, y: 0 }, config: { duration_value: 5, unit: 'minutes' } },
          { id: 's1', type: 'stage_move', label: 'Mover', position: { x: 300, y: 0 }, config: { pipeline_id: VALID_AGENT_ID, stage_id: VALID_PINNED_VERSION_ID } },
          { id: 'e1', type: 'end', label: 'Fim', position: { x: 400, y: 0 }, config: { outcome: 'converted' } },
        ],
        edges: [
          { id: 'e1', source: 't1', target: 'm1', priority: 1, condition: { type: 'always' } },
          { id: 'e2', source: 'm1', target: 'd1', priority: 1, condition: { type: 'always' } },
          { id: 'e3', source: 'd1', target: 's1', priority: 1, condition: { type: 'always' } },
          { id: 'e4', source: 's1', target: 'e1', priority: 1, condition: { type: 'always' } },
        ],
      };

      const parsed = flowGraphSchema.safeParse(v2Graph);
      expect(parsed.success).toBe(true);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { validateFlowForPublish, FLOW_MAX_STATIC_PATH_STEPS, calculateFlowLongestPath } from './validate-publish';
import { flowGraphSchema, type FlowGraph, type FlowNode, type FlowEdge } from './graph-schema';

const pos = { x: 0, y: 0 };
const TEMPLATE_ID = '00000000-0000-4000-8000-000000000000';

function trigger(id: string): FlowNode {
  return { id, type: 'trigger', label: id, position: pos, config: {} };
}
function wait(id: string, config: Extract<FlowNode, { type: 'wait' }>['config']): FlowNode {
  return { id, type: 'wait', label: id, position: pos, config };
}
function condition(id: string): FlowNode {
  return {
    id,
    type: 'condition',
    label: id,
    position: pos,
    config: { combinator: 'and', checks: [{ field: 'steps_taken', op: 'gte', value: 0 }] },
  };
}
function classify(id: string, classes: string[], graceMs = 900_000): FlowNode {
  return {
    id,
    type: 'ai_classify',
    label: id,
    position: pos,
    config: { classes, grace_timeout_ms: graceMs, target: 'last_reply' },
  };
}
function actionTemplate(id: string, templateId = TEMPLATE_ID): FlowNode {
  return { id, type: 'action', label: id, position: pos, config: { mode: 'template', template_id: templateId } };
}
function actionAiMessage(id: string, opts: { fallback?: string } = {}): FlowNode {
  return {
    id,
    type: 'action',
    label: id,
    position: pos,
    config: { mode: 'ai_message', prompt_hint: 'hint', fallback_template_id: opts.fallback },
  };
}
function end(id: string, outcome: 'converted' | 'exhausted' | 'custom' = 'exhausted'): FlowNode {
  return { id, type: 'end', label: id, position: pos, config: { outcome } };
}

let edgeSeq = 0;
function edge(source: string, target: string, condition: FlowEdge['condition']): FlowEdge {
  edgeSeq++;
  return { id: `e${edgeSeq}`, source, target, priority: 0, condition };
}
const always = (): FlowEdge['condition'] => ({ type: 'always' });
const classMatch = (value: string): FlowEdge['condition'] => ({ type: 'class_match', value });
const condResult = (value: boolean): FlowEdge['condition'] => ({ type: 'cond_result', value });

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges };
}

describe('validateFlowForPublish', () => {
  it('flags no_trigger when there is no trigger node', () => {
    const g = graph(
      [wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [edge('w1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_trigger']);
      expect(result.errors[0]!.node_id).toBeNull();
    }
  });

  it('flags multiple_triggers for every trigger beyond the first', () => {
    const g = graph(
      [trigger('t1'), trigger('t2'), end('e1')],
      [edge('t1', 't2', always()), edge('t2', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['multiple_triggers']);
      expect(result.errors[0]!.node_id).toBe('t2');
    }
  });

  it('flags unreachable_node for nodes not reachable from the trigger', () => {
    const g = graph([trigger('t1'), end('e1'), end('orphan')], [edge('t1', 'e1', always())]);
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['unreachable_node']);
      expect(result.errors[0]!.node_id).toBe('orphan');
    }
  });

  it('flags no_end_path for reachable nodes that cannot reach an end', () => {
    const g = graph(
      [trigger('t1'), end('e1'), actionTemplate('deadend')],
      [edge('t1', 'e1', always()), edge('t1', 'deadend', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['no_end_path']);
      expect(result.errors[0]!.node_id).toBe('deadend');
    }
  });

  it('flags missing_class_edge when a declared class has no outgoing edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot', 'cold']), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_class_edge']);
      expect(result.errors[0]!.node_id).toBe('c1');
    }
  });

  it('flags missing_no_reply_edge when there is no class_match "no_reply" edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_no_reply_edge']);
    }
  });

  it('flags missing_always_fallback when there is no always edge', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot']), end('e1')],
      [edge('t1', 'c1', always()), edge('c1', 'e1', classMatch('hot')), edge('c1', 'e1', classMatch('no_reply'))]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['missing_always_fallback']);
    }
  });

  it('flags grace_too_short when grace_timeout_ms is below the 15min floor', () => {
    const g = graph(
      [trigger('t1'), classify('c1', ['hot'], 500_000), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'e1', classMatch('hot')),
        edge('c1', 'e1', classMatch('no_reply')),
        edge('c1', 'e1', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['grace_too_short']);
    }
  });

  it('flags long_wait_needs_template when accumulated wait reaches 24h before an ai_message action without fallback', () => {
    const g = graph(
      [trigger('t1'), wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }), actionAiMessage('a1'), end('e1')],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('a1');
    }
  });

  it('does not flag long_wait_needs_template when a fallback_template_id is set', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 86_400_000 }),
        actionAiMessage('a1', { fallback: TEMPLATE_ID }),
        end('e1'),
      ],
      [edge('t1', 'w1', always()), edge('w1', 'a1', always()), edge('a1', 'e1', always())]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  it('flags cycle_without_wait for a cycle containing no sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), condition('c2'), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'c2', condResult(true)),
        edge('c2', 'c1', condResult(true)),
        edge('c1', 'e1', condResult(false)),
        edge('c2', 'e1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  it('does not flag cycle_without_wait when the cycle contains a sufficient wait node', () => {
    const g = graph(
      [trigger('t1'), condition('c1'), wait('w1', { mode: 'fixed', duration_ms: 300_000 }), end('e1')],
      [
        edge('t1', 'c1', always()),
        edge('c1', 'w1', condResult(true)),
        edge('w1', 'c1', always()),
        edge('c1', 'e1', condResult(false)),
      ]
    );
    expect(validateFlowForPublish(g).ok).toBe(true);
  });

  // A regression fixture for the SCC-based cycle_without_wait check: A and B
  // form a cycle with no wait in it; C is a *separate* cycle with A that DOES
  // have a sufficient wait. A naive "does the whole component contain a wait"
  // check would merge A/B/C into one component (since C links back into A)
  // and wrongly conclude the component is safe. Removing sufficient-wait
  // nodes before computing SCCs (the actual algorithm) keeps A<->B a cycle on
  // its own and correctly flags it.
  it('flags cycle_without_wait when a wait-free cycle shares a node with a wait-guarded one', () => {
    const g = graph(
      [trigger('t1'), condition('A'), condition('B'), wait('C', { mode: 'fixed', duration_ms: 300_000 }), end('end1')],
      [
        edge('t1', 'A', always()),
        edge('A', 'B', condResult(true)),
        edge('B', 'A', condResult(true)),
        edge('A', 'C', condResult(false)),
        edge('C', 'A', always()),
        edge('B', 'end1', condResult(false)),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['cycle_without_wait']);
    }
  });

  describe('FLOW_MAX_STATIC_PATH_STEPS (100 passos) — Auditoria e Suíte Completa', () => {
    function makeLinearFlow(stepCount: number): FlowGraph {
      const waitNodes: FlowNode[] = [];
      const edges: FlowEdge[] = [];
      let prev = 't1';
      for (let i = 1; i <= stepCount - 2; i++) {
        const id = `w${i}`;
        waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
        edges.push(edge(prev, id, always()));
        prev = id;
      }
      edges.push(edge(prev, 'e1', always()));
      return graph([trigger('t1'), ...waitNodes, end('e1')], edges);
    }

    it('1. fluxo com 29 passos = PASS', () => {
      const g = makeLinearFlow(29);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(29);
    });

    it('2. fluxo com 30 passos = PASS', () => {
      const g = makeLinearFlow(30);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(30);
    });

    it('3. fluxo com 31 passos = PASS após mudança (ultrapassava limite antigo de 30)', () => {
      const g = makeLinearFlow(31);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(31);
    });

    it('4. fluxo com 50 passos = PASS', () => {
      const g = makeLinearFlow(50);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(50);
    });

    it('5. fluxo com 99 passos = PASS', () => {
      const g = makeLinearFlow(99);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(99);
    });

    it('6. fluxo com 100 passos = PASS no limite exato', () => {
      const g = makeLinearFlow(100);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(100);
    });

    it('7. fluxo com 101 passos = FAIL com mensagem aprimorada e node_id null', () => {
      const g = makeLinearFlow(101);
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.map((e) => e.code)).toEqual(['max_steps_exceeded']);
        expect(res.errors[0]?.node_id).toBeNull();
        expect(res.errors[0]?.message).toBe(
          `O caminho mais longo deste fluxo possui 101 passos. O limite atual é ${FLOW_MAX_STATIC_PATH_STEPS}.`
        );
      }
    });

    it('8. branch curta + branch longa usa maior caminho', () => {
      const t = trigger('t1');
      const cond = condition('c1');
      const eCond = edge('t1', 'c1', always());

      // Branch curta: c1 -> w_short -> end_short (4 passos no total: t1, c1, w_short, end_short)
      const wShort = wait('w_short', { mode: 'fixed', duration_ms: 300_000 });
      const endShort = end('e_short');
      const eShort1 = edge('c1', 'w_short', condResult(true));
      const eShort2 = edge('w_short', 'e_short', always());

      // Branch longa: c1 -> w_long_1 .. w_long_40 -> end_long (43 passos no total: t1, c1, 40 waits, end_long)
      const longWaits: FlowNode[] = [];
      const longEdges: FlowEdge[] = [];
      let prevLong = 'c1';
      for (let i = 1; i <= 40; i++) {
        const id = `wl_${i}`;
        longWaits.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
        longEdges.push(edge(prevLong, id, i === 1 ? condResult(false) : always()));
        prevLong = id;
      }
      const endLong = end('e_long');
      longEdges.push(edge(prevLong, 'e_long', always()));

      const g = graph(
        [t, cond, wShort, endShort, ...longWaits, endLong],
        [eCond, eShort1, eShort2, ...longEdges]
      );
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(43); // 1 trigger + 1 cond + 40 waits + 1 end
    });

    it('9. múltiplas branches calculadas corretamente escolhendo o caminho crítico', () => {
      const t = trigger('t1');
      const cls = classify('cls1', ['a', 'b', 'c']);
      const eCls = edge('t1', 'cls1', always());

      const createBranch = (name: string, count: number, outcome: 'converted' | 'exhausted') => {
        const wNodes: FlowNode[] = [];
        const eList: FlowEdge[] = [];
        let p = 'cls1';
        for (let i = 1; i <= count; i++) {
          const id = `${name}_${i}`;
          wNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
          eList.push(edge(p, id, i === 1 ? classMatch(name) : always()));
          p = id;
        }
        const eNode = end(`end_${name}`, outcome);
        eList.push(edge(p, eNode.id, always()));
        return { wNodes, eList, eNode };
      };

      const bA = createBranch('a', 10, 'converted'); // 1 + 1 + 10 + 1 = 13 passos
      const bB = createBranch('b', 30, 'exhausted'); // 1 + 1 + 30 + 1 = 33 passos
      const bC = createBranch('c', 60, 'converted'); // 1 + 1 + 60 + 1 = 63 passos
      const noReply = end('e_no_reply');
      const eNoReply = edge('cls1', 'e_no_reply', classMatch('no_reply'));
      const alwaysFb = end('e_always');
      const eAlways = edge('cls1', 'e_always', always());

      const g = graph(
        [t, cls, ...bA.wNodes, bA.eNode, ...bB.wNodes, bB.eNode, ...bC.wNodes, bC.eNode, noReply, alwaysFb],
        [eCls, ...bA.eList, ...bB.eList, ...bC.eList, eNoReply, eAlways]
      );
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(63); // caminho crítico da branch 'c'
    });

    it('10. ciclo inválido continua bloqueado', () => {
      const t = trigger('t1');
      const a1 = actionTemplate('a1');
      const a2 = actionTemplate('a2');
      const e1 = end('e1');
      const g = graph(
        [t, a1, a2, e1],
        [
          edge('t1', 'a1', always()),
          edge('a1', 'a2', always()),
          edge('a2', 'a1', always()), // ciclo sem espera >= 5min
          edge('a2', 'e1', always()),
        ]
      );
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.map((e) => e.code)).toContain('cycle_without_wait');
      }
    });

    it('11. flow sem end continua bloqueado', () => {
      const t = trigger('t1');
      const w1 = wait('w1', { mode: 'fixed', duration_ms: 300_000 });
      const w2 = wait('w2', { mode: 'fixed', duration_ms: 300_000 });
      const e1 = end('e1');
      const g = graph(
        [t, w1, w2, e1],
        [
          edge('t1', 'w1', always()),
          edge('w1', 'w2', always()), // w2 não vai a lugar nenhum nem a end
          edge('w1', 'e1', always()),
        ]
      );
      const res = validateFlowForPublish(g);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.map((e) => e.code)).toContain('no_end_path');
        const err = res.errors.find((e) => e.code === 'no_end_path');
        expect(err?.node_id).toBe('w2');
      }
    });

    it('12. Node IA dentro de fluxo longo publica', () => {
      const waitNodes: FlowNode[] = [];
      const edges: FlowEdge[] = [];
      let prev = 't1';
      for (let i = 1; i <= 50; i++) {
        const id = `w_pre_${i}`;
        waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
        edges.push(edge(prev, id, always()));
        prev = id;
      }
      const aiNode: FlowNode = {
        id: 'ai_1',
        type: 'ai_node',
        label: 'Node IA Consultor',
        position: pos,
        config: {
          mode: 'custom_prompt',
          objective: 'Qualificar lead para plano premium',
          custom_prompt: 'Pergunte o faturamento mensal do cliente.',
          max_turns: 5,
        },
      };
      edges.push(edge(prev, 'ai_1', always()));
      prev = 'ai_1';
      for (let i = 1; i <= 20; i++) {
        const id = `w_post_${i}`;
        waitNodes.push(wait(id, { mode: 'fixed', duration_ms: 300_000 }));
        edges.push(edge(prev, id, always()));
        prev = id;
      }
      edges.push(edge(prev, 'e1', always()));
      const g = graph([trigger('t1'), ...waitNodes, aiNode, end('e1')], edges); // total: 1 + 50 + 1 + 20 + 1 = 73 nós
      const res = validateFlowForPublish(g, { aiNodeEnabled: true });
      expect(res.ok).toBe(true);
      expect(calculateFlowLongestPath(g)).toBe(73);
    });

    it('13. Performance com 100 nodes — publish validation, serialization, save schema', () => {
      const g = makeLinearFlow(100);

      // Publish validation time
      const tVal0 = performance.now();
      const valRes = validateFlowForPublish(g);
      const tValElapsed = performance.now() - tVal0;
      expect(valRes.ok).toBe(true);
      expect(tValElapsed).toBeLessThan(100);

      // Serialization time
      const tSer0 = performance.now();
      const json = JSON.stringify(g);
      const parsed = JSON.parse(json);
      const tSerElapsed = performance.now() - tSer0;
      expect(parsed.nodes.length).toBe(100);
      expect(tSerElapsed).toBeLessThan(50);

      // Save time (flowGraphSchema safeParse)
      const tSave0 = performance.now();
      const schemaRes = flowGraphSchema.safeParse(g);
      const tSaveElapsed = performance.now() - tSave0;
      expect(schemaRes.success).toBe(true);
      expect(tSaveElapsed).toBeLessThan(100);
    });
  });

  // Regression for the old per-path DFS: a width-2 "diamond" DAG re-converges
  // every layer, so the number of distinct trigger->leaf paths is 2^layers —
  // astronomically more than the old MAX_DFS_CALLS cap could enumerate for a
  // schema-legal 60-node graph, which silently truncated and could miss a
  // violation. The SCC-condensation sweep is O(V+E) regardless of path count,
  // so this must both finish fast and still catch the violator correctly.
  it('flags long_wait_needs_template in a wide reconverging DAG without blowing up', () => {
    // 27 wait layers + trigger + action + end = 30 steps exactly, so this
    // exercises long_wait_needs_template in isolation without also crossing
    // the (separately regression-tested) max_steps_exceeded boundary.
    const LAYERS = 27;
    const LAYER_WAIT_MS = 3_200_000; // 27 * 3.2M = 86.4M ms == 24h threshold
    const nodes: FlowNode[] = [trigger('t1')];
    const edges: FlowEdge[] = [];

    const layerId = (layer: number, branch: 'a' | 'b') => `d${layer}_${branch}`;

    for (let layer = 1; layer <= LAYERS; layer++) {
      nodes.push(wait(layerId(layer, 'a'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));
      nodes.push(wait(layerId(layer, 'b'), { mode: 'fixed', duration_ms: LAYER_WAIT_MS }));

      const sources =
        layer === 1 ? (['t1', 't1'] as const) : ([layerId(layer - 1, 'a'), layerId(layer - 1, 'b')] as const);
      for (const source of sources) {
        edges.push(edge(source, layerId(layer, 'a'), always()));
        edges.push(edge(source, layerId(layer, 'b'), always()));
      }
    }

    nodes.push(actionAiMessage('act_bad')); // violator: no fallback_template_id
    nodes.push(actionTemplate('act_ok'));
    nodes.push(end('end_diamond'));
    for (const source of [layerId(LAYERS, 'a'), layerId(LAYERS, 'b')] as const) {
      edges.push(edge(source, 'act_bad', always()));
      edges.push(edge(source, 'act_ok', always()));
    }
    edges.push(edge('act_bad', 'end_diamond', always()));
    edges.push(edge('act_ok', 'end_diamond', always()));

    expect(nodes.length).toBe(58); // well within the schema's 60-node cap

    const start = performance.now();
    const result = validateFlowForPublish(graph(nodes, edges));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1000); // polynomial, not exponential
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['long_wait_needs_template']);
      expect(result.errors[0]!.node_id).toBe('act_bad');
    }
  });

  it('passes a well-formed flow using all six node types', () => {
    const g = graph(
      [
        trigger('t1'),
        wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
        condition('cond1'),
        classify('cl1', ['hot', 'cold']),
        actionTemplate('a_hot'),
        actionAiMessage('a_cold', { fallback: TEMPLATE_ID }),
        end('end_won', 'converted'),
        end('end_lost', 'exhausted'),
      ],
      [
        edge('t1', 'w1', always()),
        edge('w1', 'cond1', always()),
        edge('cond1', 'cl1', condResult(true)),
        edge('cond1', 'end_lost', condResult(false)),
        edge('cl1', 'a_hot', classMatch('hot')),
        edge('cl1', 'a_cold', classMatch('cold')),
        edge('cl1', 'end_lost', classMatch('no_reply')),
        edge('cl1', 'end_lost', always()),
        edge('a_hot', 'end_won', always()),
        edge('a_cold', 'end_won', always()),
      ]
    );
    const result = validateFlowForPublish(g);
    expect(result.ok).toBe(true);
  });
});

/**
 * Cobertura por ramo no modo 'per_check'. A regra é NOVA e vale só para a forma
 * nova: um nó de condição combinado continua publicando sob as mesmas exigências
 * de sempre, senão o publish passaria a reprovar fluxo que já está rodando.
 */
describe('validateFlowForPublish — cobertura por ramo (per_check)', () => {
  const VIP = { id: 'chk_vip', label: 'Cliente VIP', field: 'tag' as const, op: 'contains' as const, value: 'vip' };
  const FRIO = { id: 'chk_frio', field: 'steps_taken' as const, op: 'gte' as const, value: 3 };
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function perCheck(id: string): FlowNode {
    return {
      id,
      type: 'condition',
      label: id,
      position: pos,
      config: { combinator: 'and', branching: 'per_check', checks: [VIP, FRIO] },
    };
  }

  /** trigger -> c1 -> (ramos) -> end. `extra` são as arestas de saída do nó de condição. */
  function comRamos(extra: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), perCheck('c1'), end('fim')],
      [edge('t1', 'c1', always()), ...extra]
    );
  }

  it('publica quando toda saída, inclusive a de "nenhuma delas", tem destino', () => {
    const result = validateFlowForPublish(
      comRamos([
        edge('c1', 'fim', branch('chk_vip')),
        edge('c1', 'fim', branch('chk_frio')),
        edge('c1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova nomeando a REGRA que ficou sem saída, não "o nó está incompleto"', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('chk_frio');
    expect(semSaida[0]!.node_id).toBe('c1');
  });

  it('usa o rótulo que o usuário escreveu na mensagem', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_frio')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.find((e) => e.branch_id === 'chk_vip')!.message).toContain('Cliente VIP');
  });

  it('sem rótulo, quem descreve a regra é o vocabulário — nunca o id cru', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', always())])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = result.errors.find((e) => e.branch_id === 'chk_frio')!.message;
    expect(msg).not.toContain('chk_frio');
    expect(msg).not.toContain('steps_taken');
    expect(msg).toMatch(/passos/i);
  });

  it('reprova quando falta a saída "nenhuma delas" — é ela que impede lead parado', () => {
    const result = validateFlowForPublish(
      comRamos([edge('c1', 'fim', branch('chk_vip')), edge('c1', 'fim', branch('chk_frio'))])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semEscape = result.errors.filter((e) => e.code === 'missing_always_fallback');
    expect(semEscape).toHaveLength(1);
    expect(semEscape[0]!.branch_id).toBe('else');
  });

  it('NÃO aplica a regra nova a um nó combinado — fluxo v1 publica como sempre publicou', () => {
    // Mesmas duas regras, modo de hoje, e só a saída do "sim" ligada: sob a regra
    // do per_check isto teria 2 erros. Em combinado tem que continuar passando.
    const combinado: FlowNode = {
      id: 'c1',
      type: 'condition',
      label: 'c1',
      position: pos,
      config: { combinator: 'and', checks: [VIP, FRIO] },
    };
    const g = graph(
      [trigger('t1'), combinado, end('fim')],
      [edge('t1', 'c1', always()), edge('c1', 'fim', condResult(true))]
    );
    expect(validateFlowForPublish(g)).toEqual({ ok: true });
  });
});

/**
 * Terceira ocorrência da mesma classe de defeito, apontada pelo DevVivo: a
 * cobertura de classes exigia aresta `class_match` por classe e para
 * `no_reply`. Num nó já migrado para ramos nomeados as arestas são `branch` —
 * então um grafo VÁLIDO era reprovado no publish, e o operador ficava sem
 * conseguir publicar sem entender por quê.
 */
describe('validateFlowForPublish — cobertura por ramo num ai_classify migrado', () => {
  const RAMOS = [
    { id: 'br_quente', label: 'quente' },
    { id: 'br_frio', label: 'frio' },
  ];
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function classifyV2(id: string): FlowNode {
    return {
      id,
      type: 'ai_classify',
      label: id,
      position: pos,
      config: { classes: ['quente', 'frio'], branches: RAMOS, grace_timeout_ms: 900_000, target: 'last_reply' },
    };
  }

  function grafo(saidas: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), classifyV2('ac1'), end('fim')],
      [edge('t1', 'ac1', always()), ...saidas]
    );
  }

  it('publica um grafo v2 com uma aresta por ramo — sem exigir class_match nenhum', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('br_frio')),
        edge('ac1', 'fim', branch('no_reply')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova nomeando a CLASSE que ficou sem saída', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('no_reply')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('br_frio');
    expect(semSaida[0]!.message).toContain('frio');
  });

  it('reprova quando falta a saída de quem não respondeu', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('ac1', 'fim', branch('br_quente')),
        edge('ac1', 'fim', branch('br_frio')),
        edge('ac1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.branch_id === 'no_reply')).toBe(true);
  });
});

describe('validateFlowForPublish — cobertura por ramo num match_reply', () => {
  const RAMOS = [
    { id: 'br_sim', label: 'Sim', op: 'eq' as const, pattern: 'sim' },
    { id: 'br_nao', label: 'Não', op: 'contains' as const, pattern: 'nao' },
  ];
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function matchV2(id: string): FlowNode {
    return {
      id,
      type: 'match_reply',
      label: id,
      position: pos,
      config: { branches: RAMOS, grace_timeout_ms: 900_000 },
    };
  }

  function grafo(saidas: FlowEdge[]): FlowGraph {
    return graph(
      [trigger('t1'), matchV2('mr1'), end('fim')],
      [edge('t1', 'mr1', always()), ...saidas]
    );
  }

  it('publica com uma aresta por ramo + no_reply + always', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('mr1', 'fim', branch('br_sim')),
        edge('mr1', 'fim', branch('br_nao')),
        edge('mr1', 'fim', branch('no_reply')),
        edge('mr1', 'fim', always()),
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova ramo declarado sem saída', () => {
    const result = validateFlowForPublish(
      grafo([
        edge('mr1', 'fim', branch('br_sim')),
        edge('mr1', 'fim', branch('no_reply')),
        edge('mr1', 'fim', always()),
      ])
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const semSaida = result.errors.filter((e) => e.code === 'missing_branch_edge');
    expect(semSaida).toHaveLength(1);
    expect(semSaida[0]!.branch_id).toBe('br_nao');
  });
});

describe('validateFlowForPublish — cobertura por ramo num repeat', () => {
  const branch = (branchId: string): FlowEdge['condition'] => ({ type: 'branch', branch_id: branchId });

  function repeatNode(id: string): FlowNode {
    return { id, type: 'repeat', label: id, position: pos, config: { max_count: 12 } };
  }

  it('publica com body + done + always e um wait no ciclo', () => {
    const result = validateFlowForPublish(
      graph(
        [
          trigger('t1'),
          repeatNode('rp1'),
          wait('w1', { mode: 'fixed', duration_ms: 300_000 }),
          end('fim'),
        ],
        [
          edge('t1', 'rp1', always()),
          edge('rp1', 'w1', branch('body')),
          edge('rp1', 'fim', branch('done')),
          edge('rp1', 'fim', always()),
          edge('w1', 'rp1', always()),
        ]
      )
    );
    expect(result).toEqual({ ok: true });
  });

  it('reprova sem a saída de próxima volta', () => {
    const result = validateFlowForPublish(
      graph(
        [trigger('t1'), repeatNode('rp1'), end('fim')],
        [
          edge('t1', 'rp1', always()),
          edge('rp1', 'fim', branch('done')),
          edge('rp1', 'fim', always()),
        ]
      )
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.branch_id === 'body')).toBe(true);
  });
});

/**
 * Regra que não decide nada não publica. Três formas MEDIDAS de uma regra que a
 * tela deixava com cara de pronta e o motor nunca satisfaz (ou satisfaz sempre):
 * valor vazio, número de passos que não é número, e etapa que não é etapa — a
 * clínica digitava "PAGO" e o motor compara o `stage_id`. O rascunho continua
 * aceitando tudo isso (trabalho pela metade precisa salvar); quem recusa é o
 * publish, no momento em que há alguém na tela para corrigir.
 */
describe('validateFlowForPublish — a regra precisa poder decidir', () => {
  const ETAPA_PAGO = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const ETAPA_ARQUIVADA = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  const ETAPA_APAGADA = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
  const etapas = new Map([
    [ETAPA_PAGO, { nome: 'Pago · Vendas', arquivada: false }],
    [ETAPA_ARQUIVADA, { nome: 'Antiga · Vendas', arquivada: true }],
  ]);
  type Check = Extract<FlowNode, { type: 'condition' }>['config']['checks'][number];

  /** trigger -> c1 -> fim, com TODA saída ligada: o único erro possível é o da regra. */
  function comRegras(checks: Check[], modo: 'combined' | 'per_check' = 'combined'): FlowGraph {
    const porRegra = modo === 'per_check';
    const c1: FlowNode = {
      id: 'c1',
      type: 'condition',
      label: 'c1',
      position: pos,
      config: {
        combinator: 'and',
        ...(porRegra ? { branching: 'per_check' as const } : {}),
        checks: porRegra ? checks.map((c, i) => ({ ...c, id: `regra-${i + 1}` })) : checks,
      },
    };
    const saidas = porRegra
      ? [...checks.map((_, i) => edge('c1', 'fim', { type: 'branch', branch_id: `regra-${i + 1}` })), edge('c1', 'fim', always())]
      : [edge('c1', 'fim', condResult(true)), edge('c1', 'fim', condResult(false))];
    return graph([trigger('t1'), c1, end('fim')], [edge('t1', 'c1', always()), ...saidas]);
  }

  const codigos = (r: ReturnType<typeof validateFlowForPublish>) => (r.ok ? [] : r.errors.map((e) => e.code));

  it('regra sem valor reprova nos dois modos, e no modo por regra aponta a saída', () => {
    const vazia: Check = { field: 'tag', op: 'eq', value: '  ' };
    expect(codigos(validateFlowForPublish(comRegras([vazia]), { etapas }))).toEqual(['empty_check_value']);

    const r = validateFlowForPublish(comRegras([{ field: 'tag', op: 'eq', value: 'vip' }, vazia], 'per_check'), { etapas });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ node_id: 'c1', code: 'empty_check_value', branch_id: 'regra-2' });
    expect(r.errors[0]!.message).toMatch(/Regra 2/);
  });

  it('passos com texto que não é número reprova; o número digitado como texto passa', () => {
    expect(codigos(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'gte', value: 'três' }]), { etapas }))).toEqual([
      'check_value_not_number',
    ]);
    expect(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'gte', value: '3' }]), { etapas })).toEqual({ ok: true });
    // O motor compara 2.5 sem problema: recusar seria recusar o que funciona.
    expect(validateFlowForPublish(comRegras([{ field: 'steps_taken', op: 'lte', value: 2.5 }]), { etapas })).toEqual({ ok: true });
  });

  it('etapa digitada pelo nome (fluxo antigo) reprova pedindo para escolher na lista', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: 'PAGO' }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_not_found']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('PAGO');
    expect(r.errors[0]!.message).toMatch(/escolha a etapa/i);
  });

  it('etapa apagada reprova sem ecoar o identificador', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'neq', value: ETAPA_APAGADA }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_not_found']);
    if (r.ok) return;
    expect(r.errors[0]!.message).not.toContain(ETAPA_APAGADA);
  });

  it('etapa arquivada reprova — nenhum negócio fica nela, a regra nunca decide', () => {
    const r = validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_ARQUIVADA }]), { etapas });
    expect(codigos(r)).toEqual(['check_stage_archived']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('Antiga · Vendas');
  });

  it('etapa ativa publica, e outra falha no mesmo nó fala o NOME da etapa, nunca o id', () => {
    expect(validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_PAGO }]), { etapas })).toEqual({ ok: true });

    const semSaida = comRegras([{ field: 'lead_stage', op: 'eq', value: ETAPA_PAGO }], 'per_check');
    semSaida.edges = semSaida.edges.filter((e) => e.condition.type !== 'branch');
    const r = validateFlowForPublish(semSaida, { etapas });
    expect(codigos(r)).toEqual(['missing_branch_edge']);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain('Pago · Vendas');
    expect(r.errors[0]!.message).not.toContain(ETAPA_PAGO);
  });

  it('sem a lista de etapas a etapa não é conferida — só quem lê o banco pode dizer se ela existe', () => {
    expect(validateFlowForPublish(comRegras([{ field: 'lead_stage', op: 'eq', value: 'PAGO' }]))).toEqual({ ok: true });
  });
});

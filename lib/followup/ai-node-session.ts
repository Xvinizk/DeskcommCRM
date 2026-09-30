import { z } from 'zod';

/**
 * Resumo determinístico de mídias recebidas durante a sessão do Node IA.
 */
export const aiNodeSessionMediaSummarySchema = z.object({
  images_count: z.number().int().nonnegative().default(0),
  audios_count: z.number().int().nonnegative().default(0),
  documents_count: z.number().int().nonnegative().default(0),
  last_media_ids: z.array(z.string()).default([]),
});

export type AiNodeSessionMediaSummary = z.infer<typeof aiNodeSessionMediaSummarySchema>;

/**
 * Status do ciclo de vida da sessão do Node IA.
 */
export const aiNodeSessionStatusSchema = z.enum([
  'running',
  'completed',
  'timeout',
  'max_turns',
  'handoff',
  'error',
]);

export type AiNodeSessionStatus = z.infer<typeof aiNodeSessionStatusSchema>;

/**
 * Estado transiente de execução do Node IA persistido em `followup_enrollments.ai_node_session`.
 * Fonte canônica de ownership do Node IA.
 */
export const aiNodeSessionSchema = z.object({
  /** ID do nó de IA no grafo do fluxo */
  node_id: z.string(),
  /** ID do fluxo ao qual o nó pertence */
  flow_id: z.string().optional().nullable(),
  /** Modo de operação configurado no nó */
  mode: z.enum(['existing_agent', 'custom_prompt', 'existing_with_supplementary']).default('existing_agent'),
  /** ID do agente selecionado (quando aplicável) */
  agent_id: z.string().uuid().optional().nullable(),
  /** Versão pinada do agente (quando aplicável) */
  agent_version_id: z.string().uuid().optional().nullable(),
  /** Status da sessão do nó */
  status: aiNodeSessionStatusSchema.default('running'),
  /** Quantidade de mensagens inbound únicas processadas neste nó */
  turn_count: z.number().int().nonnegative().default(0),
  /** Limite máximo de turnos configurado para o nó */
  max_turns: z.number().int().positive().optional().nullable(),
  /** Timestamp de entrada no nó (ISO-8601 UTC) */
  started_at: z.string(),
  /** Timestamp da última mensagem inbound processada neste nó (ISO-8601 UTC) */
  last_inbound_at: z.string().optional().nullable(),
  /** Timestamp limite para timeout do nó (ISO-8601 UTC) */
  timeout_at: z.string().optional().nullable(),
  /** Resumo de mídias recebidas desde started_at */
  media_summary: aiNodeSessionMediaSummarySchema.optional().default({
    images_count: 0,
    audios_count: 0,
    documents_count: 0,
    last_media_ids: [],
  }),
  /** Motivo de encerramento do nó (quando concluído) */
  completion_reason: z.string().optional().nullable(),
});

export type AiNodeSession = z.infer<typeof aiNodeSessionSchema>;

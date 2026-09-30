import { z } from 'zod';

/**
 * Schema canônico do resultado semântico do Node IA (Fase 4).
 * O resultado semântico da LLM permite exclusivamente:
 * - reply: texto conversacional limpo a ser enviado para o cliente
 * - node_status: decisão de avanço ("continue" | "completed" | "handoff")
 * - outcome: string curta descrevendo o desfecho ou null
 * - extracted_data: dicionário de dados extraídos durante a conversa (uso interno)
 *
 * "error", "timeout" e "max_turns" NÃO são estados semânticos do modelo;
 * são estados de controle operacional gerados estritamente pelo runtime.
 */
export const aiNodeStructuredOutputSchema = z.strictObject({
  reply: z.string().min(1, 'A resposta (reply) não pode ser vazia'),
  node_status: z.enum(['continue', 'completed', 'handoff']),
  outcome: z.string().nullable().default(null),
  extracted_data: z.record(z.string(), z.unknown()).default({}),
});

export type AiNodeStructuredOutput = z.infer<typeof aiNodeStructuredOutputSchema>;

/**
 * Monta a diretriz de formatação de Structured Output para ser injetada no System Prompt.
 */
export function buildAiNodeStructuredOutputDirective(): string {
  return [
    '### DIRETRIZ OBRIGATÓRIA DE RESPOSTA ESTRUTURADA (JSON)',
    'Você DEVE responder ESTRITAMENTE em formato JSON válido, sem texto antes ou depois.',
    'O schema JSON obrigatório é:',
    '{',
    '  "reply": "string (A mensagem exata que será enviada para o cliente no WhatsApp. NUNCA coloque JSON ou instruções técnicas aqui)",',
    '  "node_status": "continue" | "completed" | "handoff",',
    '  "outcome": "string ou null (Um resumo breve do desfecho se o nó foi completed ou handoff, ex: dados_coletados, agendamento_iniciado; ou null)",',
    '  "extracted_data": { /* campos e informações extraídos da conversa para registro interno */ }',
    '}',
    '',
    'Regras para "node_status":',
    '- "continue": Escolha isto quando o objetivo deste nó ainda NÃO foi atingido e você precisa de mais informações do cliente ou continuar dialogando.',
    '- "completed": Escolha isto quando a meta ou condição de conclusão deste nó foi plenamente satisfeita e o fluxo deve avançar.',
    '- "handoff": Escolha isto se o cliente solicitou atendimento humano ou se a situação exige um atendente humano imediatamente.',
    '',
    'IMPORTANTE: Responda SOMENTE o bloco JSON válido.',
  ].join('\n');
}

/**
 * Parser resiliente e estrito para o Structured Output da LLM.
 *
 * Tratamento:
 * 1. Remove cercas de markdown (```json ou ```).
 * 2. Localiza o primeiro '{' e o último '}' para isolar o JSON caso a LLM tenha emitido texto ao redor.
 * 3. Faz parse JSON seguro.
 * 4. Valida via Zod schema estrito.
 * 5. Se inválido, NUNCA tenta adivinhar branch com regex nem vaza JSON quebrado para o cliente.
 */
export function parseAiNodeStructuredOutput(rawText: string):
  | { ok: true; data: AiNodeStructuredOutput }
  | { ok: false; error: string; rawSnippet?: string } {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { ok: false, error: 'empty_llm_response' };
  }

  let cleaned = rawText.trim();

  // Remove blocos de código markdown se presentes
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  cleaned = cleaned.trim();

  // Localiza limites do JSON se houver texto envolvente
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return {
      ok: false,
      error: 'no_json_object_found',
      rawSnippet: rawText.slice(0, 150),
    };
  }

  const jsonSubstring = cleaned.slice(firstBrace, lastBrace + 1);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonSubstring);
  } catch (err) {
    return {
      ok: false,
      error: `json_parse_error: ${err instanceof Error ? err.message : String(err)}`,
      rawSnippet: jsonSubstring.slice(0, 150),
    };
  }

  const validation = aiNodeStructuredOutputSchema.safeParse(parsedJson);
  if (!validation.success) {
    return {
      ok: false,
      error: `schema_validation_error: ${validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      rawSnippet: jsonSubstring.slice(0, 150),
    };
  }

  return { ok: true, data: validation.data };
}

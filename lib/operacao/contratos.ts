/**
 * Contratos do painel da operação — o que as rotas aceitam e a régua do período.
 *
 * `origin` NÃO existe aqui de propósito: a rota grava `manual` fixo. Deixar o
 * corpo escolher `lead_won` permitiria uma venda "do funil" sem lead nenhum.
 */
import { z } from "zod";

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO_MAXIMO_DIAS = 366;

export const vendaSchema = z.object({
  amount_cents: z.number().int().min(1).max(1_000_000_000),
  quantity: z.number().int().min(1).max(1000).default(1),
  sold_on: z.string().regex(DIA, "Data inválida."),
  description: z.string().trim().min(1).max(300).optional(),
  contact_id: z.string().uuid().optional(),
  payment_method_id: z.string().uuid().optional(),
});
export type VendaEntrada = z.infer<typeof vendaSchema>;

export const gastoSchema = z.object({
  spend_date: z.string().regex(DIA, "Data inválida."),
  amount_cents: z.number().int().min(0).max(1_000_000_000),
});
export type GastoEntrada = z.infer<typeof gastoSchema>;

/** Data YYYY-MM-DD que existe no calendário (recusa 30/02). */
function diaReal(s: string | null): s is string {
  if (!s || !DIA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type Periodo = { ok: true; de: string; ate: string } | { ok: false; motivo: string };

export function periodoValido(de: string | null, ate: string | null): Periodo {
  if (!diaReal(de) || !diaReal(ate)) return { ok: false, motivo: "Informe início e fim no formato AAAA-MM-DD." };
  if (de > ate) return { ok: false, motivo: "O início precisa ser antes do fim." };
  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000 + 1;
  if (dias > PERIODO_MAXIMO_DIAS) return { ok: false, motivo: "O período pode ter no máximo 366 dias." };
  return { ok: true, de, ate };
}

/** ROAS como a pessoa lê: "3,25x". Sem gasto, não há ROAS. */
export function formatarRoas(roas: number | null): string {
  if (roas === null) return "—";
  return `${roas.toFixed(2).replace(".", ",")}x`;
}

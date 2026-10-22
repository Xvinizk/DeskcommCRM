/**
 * AS VENDAS REGISTRADAS — "vendi tal coisa" no contato, ou "fiz 3 vendas hoje".
 *
 * ⚠️ `origin` é gravado como `'manual'` e não vem do corpo: `lead_won` só nasce
 * do gatilho do funil (migration 0389). Se o corpo escolhesse, existiria venda
 * "do funil" sem lead por trás, e o painel a contaria como conversão.
 *
 * ⚠️ O contato e a forma de pagamento são conferidos NA ORGANIZAÇÃO da sessão.
 * A chave estrangeira só garante que o id existe — em qualquer organização.
 *
 * ⚠️ O audit leva só números. A descrição é texto livre e pode nomear a pessoa;
 * o audit é append-only e fica fora do alcance da anonimização da LGPD.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { periodoValido, vendaSchema } from "@/lib/operacao/contratos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/v1/operacao/vendas";
const LIMITE = 500;
const COLUNAS =
  "id, sold_on, quantity, amount_cents, currency, description, contact_id, lead_id, payment_method_id, origin, status, reversed_at, created_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const periodo = periodoValido(url.searchParams.get("de"), url.searchParams.get("ate"));
  if (!periodo.ok) return fail("validation_failed", periodo.motivo, 422, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("operation_sales")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .gte("sold_on", periodo.de)
    .lte("sold_on", periodo.ate)
    .order("sold_on", { ascending: false })
    .limit(LIMITE);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const lido = vendaSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }
  const venda = lido.data;
  const supabase = await createClient();

  for (const [tabela, id, msg] of [
    ["contacts", venda.contact_id, "Contato não encontrado."],
    ["payment_methods", venda.payment_method_id, "Forma de pagamento não encontrada."],
  ] as const) {
    if (!id) continue;
    const { data } = await supabase.from(tabela).select("id").eq("organization_id", orgId).eq("id", id).maybeSingle();
    if (!data) return fail("validation_failed", msg, 422, { requestId });
  }

  async function criar() {
    const { data, error } = await supabase
      .from("operation_sales")
      .insert({
        organization_id: orgId,
        sold_on: venda.sold_on,
        quantity: venda.quantity,
        amount_cents: venda.amount_cents,
        description: venda.description ?? null,
        contact_id: venda.contact_id ?? null,
        payment_method_id: venda.payment_method_id ?? null,
        origin: "manual",
        created_by_user_id: authz.ok ? authz.user.id : null,
      })
      .select(COLUNAS)
      .single();
    if (error || !data) throw new Error(error?.message ?? "operation_sale_insert_failed");

    await audit({
      action: "operacao.venda_registrada",
      resourceType: "operation_sale",
      resourceId: (data as { id: string }).id,
      requestId,
      metadata: {
        amount_cents: venda.amount_cents,
        quantity: venda.quantity,
        sold_on: venda.sold_on,
        com_contato: Boolean(venda.contact_id),
      },
    });
    return data;
  }

  const chave = chaveDaRequisicao(req);
  try {
    if (chave === null) return ok(await criar(), { requestId, status: 201 });

    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: venda,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });
    if (desfecho.tipo === "conflito")
      return fail("idempotency_conflict", "Esta chave de idempotência já foi usada com outro conteúdo.", 409, { requestId });
    if (desfecho.tipo === "em_curso")
      return fail("idempotency_in_progress", "A mesma requisição ainda está em curso. Tente de novo em instantes.", 409, { requestId });
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", "Não foi possível registrar a venda.", 500, { requestId });
  }
}

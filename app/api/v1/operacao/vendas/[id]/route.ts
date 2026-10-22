/**
 * ESTORNAR uma venda registrada. Não apaga: muda `status` para `reversed`.
 *
 * Venda do funil (`origin = 'lead_won'`) é recusada aqui: quem manda nela é o
 * lead. Estornar pela tela deixaria o lead em Ganho com a venda estornada, e o
 * próximo arrasto a reativaria sem ninguém entender por quê.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data: venda, error } = await supabase
    .from("operation_sales")
    .select("id, origin, status, amount_cents")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!venda) return fail("not_found", "Venda não encontrada.", 404, { requestId });

  const v = venda as { id: string; origin: string; status: string; amount_cents: number };
  if (v.origin === "lead_won") {
    return fail(
      "venda_do_funil",
      "Esta venda veio do funil. Para desfazê-la, tire o lead da etapa de Ganho.",
      409,
      { requestId },
    );
  }
  if (v.status === "reversed") return ok({ id: v.id, status: "reversed" }, { requestId });

  const { error: updErr } = await supabase
    .from("operation_sales")
    .update({ status: "reversed", reversed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("id", v.id);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  await audit({
    action: "operacao.venda_estornada",
    resourceType: "operation_sale",
    resourceId: v.id,
    requestId,
    metadata: { amount_cents: v.amount_cents },
  });
  return ok({ id: v.id, status: "reversed" }, { requestId });
}

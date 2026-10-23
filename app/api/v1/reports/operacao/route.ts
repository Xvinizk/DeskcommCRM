/**
 * O PAINEL DA OPERAÇÃO — faturamento, vendas, ticket médio, gasto e ROAS.
 *
 * Nenhuma conta aqui: tudo vem pronto de `fn_painel_operacao` (migration 0389),
 * que agrega no banco. Somar na aplicação o que o PostgREST devolve paginado é
 * como um relatório passa a mentir sem ninguém ver.
 *
 * `viewer`, como o Faturamento: conferir o número não é privilégio de quem lança.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { periodoValido } from "@/lib/operacao/contratos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const periodo = periodoValido(url.searchParams.get("de"), url.searchParams.get("ate"));
  if (!periodo.ok) return fail("validation_failed", periodo.motivo, 422, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_painel_operacao", {
    p_org: authz.org.orgId,
    p_de: periodo.de,
    p_ate: periodo.ate,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

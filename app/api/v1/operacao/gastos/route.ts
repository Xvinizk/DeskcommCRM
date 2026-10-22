/**
 * O GASTO EM ANÚNCIO DO DIA — lançado à mão na v1 (só Meta).
 *
 * PUT, e não POST: "gastei R$ 150 hoje" substitui o valor do dia, não soma.
 * Um valor manual por (dia, plataforma) — `unique` da migration 0389.
 *
 * `manager`, como a tela do Meta Ads: orçamento é da empresa inteira, não de
 * quem atende. A RLS cobra o mesmo degrau.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { gastoSchema, periodoValido } from "@/lib/operacao/contratos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, spend_date, platform, amount_cents, currency, source, updated_at";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const periodo = periodoValido(url.searchParams.get("de"), url.searchParams.get("ate"));
  if (!periodo.ok) return fail("validation_failed", periodo.motivo, 422, { requestId });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ad_spend_daily")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .gte("spend_date", periodo.de)
    .lte("spend_date", periodo.ate)
    .order("spend_date", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "operacao" });
  if (!authz.ok) return authz.response;

  const lido = gastoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ad_spend_daily")
    .upsert(
      {
        organization_id: authz.org.orgId,
        spend_date: lido.data.spend_date,
        platform: "meta",
        source: "manual",
        amount_cents: lido.data.amount_cents,
        created_by_user_id: authz.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,spend_date,platform,source" },
    )
    .select(COLUNAS)
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "operacao.gasto_lancado",
    resourceType: "ad_spend_daily",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { spend_date: lido.data.spend_date, amount_cents: lido.data.amount_cents, platform: "meta" },
  });
  return ok(data, { requestId });
}

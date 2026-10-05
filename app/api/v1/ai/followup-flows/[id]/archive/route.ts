import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/archive — arquiva fluxo (manager+).
 * Define archived_at = now().
 * Não recebe novos triggers, mas permite que execuções ativas concluam.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, name, status, archived_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  if (existing.archived_at) {
    return ok(existing, { requestId });
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("followup_flow_pointers")
    .update({ archived_at: nowIso, updated_at: nowIso })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, name, status, active_version_id, handoff_policy, updated_at, archived_at")
    .single();

  if (updErr || !updated) {
    return fail("internal_error", updErr?.message ?? "followup_flow_archive_failed", 500, {
      requestId,
    });
  }

  audit({
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    action: "followup_flow.archived",
    resourceType: "followup_flow",
    resourceId: id,
    metadata: {
      flow_name: existing.name,
      status: existing.status,
      archived_at: nowIso,
    },
    requestId,
  });

  return ok(updated, { requestId });
}

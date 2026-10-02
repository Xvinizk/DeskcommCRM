import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, versionId } = await ctx.params;

  if (!UUID_RX.test(id) || !UUID_RX.test(versionId)) {
    return fail("invalid_request", "IDs inválidos.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const admin = createAdminClient();

  // 1. Buscar o fluxo atual
  const { data: pointer, error: pointerErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, draft_graph, active_version_id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (pointerErr) return fail("internal_error", pointerErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  // 2. Buscar a versão a restaurar
  const { data: targetVersion, error: versionErr } = await admin
    .from("followup_flow_versions")
    .select("id, pointer_id, graph, label, created_at")
    .eq("id", versionId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (versionErr) return fail("internal_error", versionErr.message, 500, { requestId });
  if (!targetVersion) {
    return fail("not_found", t("Versão não encontrada para este fluxo."), 404, { requestId });
  }
  if (targetVersion.pointer_id && targetVersion.pointer_id !== id) {
    return fail("not_found", t("Versão não pertence a este fluxo."), 404, { requestId });
  }

  // 3. Salvar snapshot do rascunho atual antes de restaurar (Restauração Segura)
  const currentDraft = await rascunhoDoFluxo(
    admin,
    pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
    activeOrg.orgId,
  );

  const preRestoreLabel = `Backup pré-restauração (${new Date().toISOString()})`;
  await admin.from("followup_flow_versions").insert({
    organization_id: activeOrg.orgId,
    pointer_id: id,
    graph: currentDraft,
    created_by: user.id,
    label: preRestoreLabel,
    kind: "pre_restore",
  });

  // 4. Restaurar a versão escolhida como novo estado de rascunho
  const { error: updateErr } = await admin
    .from("followup_flow_pointers")
    .update({
      draft_graph: targetVersion.graph,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (updateErr) return fail("internal_error", updateErr.message, 500, { requestId });

  void audit({
    action: "followup_flow.updated",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: {
      action: "restore_version",
      restored_version_id: versionId,
    },
  });

  return ok(
    {
      restored: true,
      draft_graph: targetVersion.graph,
      message: t("Versão restaurada como rascunho com sucesso."),
    },
    { requestId },
  );
}

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { sanitizeFlowForSnapshot } from "@/lib/followup/sharing/sanitize";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const url = new URL(req.url);
  const versionId = url.searchParams.get("version_id");

  const admin = createAdminClient();

  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  let graph: FlowGraph;

  if (versionId && UUID_RX.test(versionId)) {
    const { data: versionRow, error: verErr } = await admin
      .from("followup_flow_versions")
      .select("graph")
      .eq("id", versionId)
      .eq("pointer_id", id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();

    if (verErr || !versionRow) {
      return fail("not_found", t("Versão não encontrada."), 404, { requestId });
    }
    graph = versionRow.graph as unknown as FlowGraph;
  } else {
    graph = (await rascunhoDoFluxo(
      admin,
      pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
      activeOrg.orgId,
    )) as unknown as FlowGraph;
  }

  const snapshot = sanitizeFlowForSnapshot({
    name: pointer.name,
    handoff_policy: pointer.handoff_policy as "pause" | "cancel" | "allow",
    trigger_config: pointer.trigger_config as Record<string, unknown>,
    graph,
  });

  const exportPayload = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    flow: {
      name: snapshot.flow_name,
      handoff_policy: snapshot.handoff_policy,
      trigger_config: snapshot.trigger_config,
    },
    nodes: snapshot.graph.nodes,
    edges: snapshot.graph.edges,
    media: snapshot.media,
  };

  return ok(exportPayload, { requestId });
}

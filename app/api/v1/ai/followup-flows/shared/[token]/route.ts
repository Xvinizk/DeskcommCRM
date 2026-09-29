import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SharedFlowSnapshot } from "@/lib/followup/sharing/sanitize";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || typeof token !== "string" || token.length < 10) {
    return fail("invalid_request", "Token inválido.", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: share, error } = await admin
    .from("followup_flow_shares")
    .select("token, status, snapshot, created_at, updated_at")
    .eq("token", token)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao carregar dados do fluxo compartilhado.", 500, { requestId });
  }

  if (!share) {
    return fail("not_found", "Link de fluxo expirado, desativado ou inexistente.", 404, { requestId });
  }

  const snapshot = share.snapshot as unknown as SharedFlowSnapshot;

  return ok(
    {
      flow_name: snapshot.flow_name,
      node_count: snapshot.node_count ?? snapshot.graph?.nodes?.length ?? 0,
      image_count: snapshot.image_count ?? 0,
      video_count: snapshot.video_count ?? 0,
      audio_count: snapshot.audio_count ?? 0,
      snapshot_date: share.updated_at || share.created_at,
    },
    { requestId },
  );
}

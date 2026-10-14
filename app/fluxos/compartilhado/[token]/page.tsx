import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { SharedFlowClient, SharedFlowUnavailable } from "./_components/SharedFlowClient";
import type { SharedFlowSnapshot } from "@/lib/followup/sharing/sanitize";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: share } = await admin
    .from("followup_flow_shares")
    .select("snapshot")
    .eq("token", token)
    .eq("status", "active")
    .maybeSingle();

  const snapshot = share?.snapshot as unknown as SharedFlowSnapshot | undefined;
  const flowName = snapshot?.flow_name ? `Fluxo: ${snapshot.flow_name}` : "Fluxo Compartilhado";

  return {
    title: `${flowName} | CRM`,
    description: "Importe este fluxo automatizado diretamente para a sua conta.",
  };
}

export default async function SharedFlowPage({ params }: Props) {
  const { token } = await params;

  // 1. Checar se o visitante tem sessão ativa
  let isAuthenticated = false;
  try {
    const supabase = await createClient();
    const { data: authData } = await supabase.auth.getUser();
    isAuthenticated = Boolean(authData?.user);
  } catch {
    isAuthenticated = false;
  }

  // 2. Buscar dados do snapshot pelo token
  const admin = createAdminClient();
  const { data: share } = await admin
    .from("followup_flow_shares")
    .select("token, status, snapshot, created_at, updated_at")
    .eq("token", token)
    .eq("status", "active")
    .maybeSingle();

  if (!share) {
    return <SharedFlowUnavailable />;
  }

  const snapshot = share.snapshot as unknown as SharedFlowSnapshot;

  return (
    <SharedFlowClient
      token={token}
      flowName={snapshot.flow_name}
      nodeCount={snapshot.node_count ?? snapshot.graph?.nodes?.length ?? 0}
      imageCount={snapshot.image_count ?? 0}
      videoCount={snapshot.video_count ?? 0}
      audioCount={snapshot.audio_count ?? 0}
      snapshotDate={share.updated_at || share.created_at}
      isAuthenticated={isAuthenticated}
    />
  );
}

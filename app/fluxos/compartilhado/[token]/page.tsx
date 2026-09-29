import type { Metadata } from "next";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { XCircle } from "@/lib/ui/icons";
import { SharedFlowClient } from "./_components/SharedFlowClient";
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
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <Card className="max-w-md p-8 text-center space-y-4 border border-border shadow-xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-error/10 text-error">
            <XCircle size={32} weight="fill" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text">Fluxo Indisponível</h1>
            <p className="mt-1 text-sm text-text-muted">
              Este link de compartilhamento foi desativado, expirou ou não existe.
            </p>
          </div>
          <div className="pt-2">
            <Link href="/app">
              <Button variant="outline" className="w-full">
                Ir para o CRM
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
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

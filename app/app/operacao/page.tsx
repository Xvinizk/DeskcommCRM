import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { PainelDaOperacao } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O PAINEL DA OPERAÇÃO — quanto vendeu, quanto custou trazer, e se o anúncio
 * se paga.
 *
 * Irmão do Faturamento, não substituto: lá é o caixa (o que entrou e saiu das
 * contas); aqui é a VENDA e o retorno do anúncio. As comandas finalizadas entram
 * nos dois, e o painel diz de onde veio cada venda.
 *
 * `viewer` lê; `agent` registra venda; `manager` lança gasto — o mesmo degrau
 * da tela do Meta Ads, porque orçamento é da empresa inteira.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Painel da operação")}</h1>
        <p className="text-sm text-text-muted">
          {t("Faturamento, vendas, ticket médio, gasto em anúncio e ROAS, dia a dia.")}
        </p>
      </div>
      <PainelDaOperacao
        podeVender={ROLE_RANK[org.role] >= ROLE_RANK.agent}
        podeLancarGasto={ROLE_RANK[org.role] >= ROLE_RANK.manager}
      />
    </div>
  );
}

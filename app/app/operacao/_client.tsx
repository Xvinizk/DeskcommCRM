"use client";
/**
 * O painel na tela.
 *
 * ⚠️ NENHUM NÚMERO É SOMADO AQUI. Faturamento, vendas, ticket, gasto, ROAS e a
 * série diária vêm prontos de `fn_painel_operacao`. Esta tela formata e dispõe.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { LancarGastoDialog } from "@/components/operacao/LancarGastoDialog";
import { RegistrarVendaDialog } from "@/components/operacao/RegistrarVendaDialog";
import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";
import { formatarRoas } from "@/lib/operacao/contratos";

type Origem = { vendas: number; faturamento_cents: number };
type Dia = { dia: string; vendas: number; faturamento_cents: number; gasto_cents: number };
type Painel = {
  de: string;
  ate: string;
  faturamento_cents: number;
  vendas: number;
  ticket_medio_cents: number;
  gasto_cents: number;
  roas: number | null;
  custo_por_venda_cents: number | null;
  por_origem: { registradas: Origem; funil: Origem; comandas: Origem };
  por_dia: Dia[];
};
type Venda = {
  id: string;
  sold_on: string;
  quantity: number;
  amount_cents: number;
  description: string | null;
  origin: "manual" | "lead_won";
  status: "active" | "reversed";
};

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const diasAtras = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};

type Atalho = "hoje" | "7" | "30" | "mes" | "livre";

function intervaloDo(atalho: Exclude<Atalho, "livre">): { de: string; ate: string } {
  const hoje = iso(new Date());
  if (atalho === "hoje") return { de: hoje, ate: hoje };
  if (atalho === "7") return { de: diasAtras(6), ate: hoje };
  if (atalho === "30") return { de: diasAtras(29), ate: hoje };
  return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
}

export function PainelDaOperacao({ podeVender, podeLancarGasto }: { podeVender: boolean; podeLancarGasto: boolean }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const qc = useQueryClient();
  const [atalho, setAtalho] = useState<Atalho>("30");
  const [periodo, setPeriodo] = useState(() => intervaloDo("30"));
  const [vendaAberta, setVendaAberta] = useState(false);
  const [gastoAberto, setGastoAberto] = useState(false);

  const escolher = (a: Exclude<Atalho, "livre">) => {
    setAtalho(a);
    setPeriodo(intervaloDo(a));
  };

  const painel = useQuery({
    queryKey: ["operacao", "painel", periodo.de, periodo.ate],
    queryFn: async () =>
      (await apiClient.get<{ data: Painel }>(`/api/v1/reports/operacao?de=${periodo.de}&ate=${periodo.ate}`)).data,
  });
  const vendas = useQuery({
    queryKey: ["operacao", "vendas", periodo.de, periodo.ate],
    queryFn: async () =>
      (await apiClient.get<{ data: Venda[] }>(`/api/v1/operacao/vendas?de=${periodo.de}&ate=${periodo.ate}`)).data,
  });

  const estornar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/operacao/vendas/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["operacao"] }),
    onError: showApiError,
  });

  const p = painel.data;
  const diaCurto = (s: string) =>
    new Date(`${s}T00:00:00Z`).toLocaleDateString(tag, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const rotuloOrigem = (o: Venda["origin"]) => (o === "lead_won" ? t("Funil (lead ganho)") : t("Registrada"));

  const atalhos: { id: Exclude<Atalho, "livre">; rotulo: string }[] = [
    { id: "hoje", rotulo: t("Hoje") },
    { id: "7", rotulo: t("7 dias") },
    { id: "30", rotulo: t("30 dias") },
    { id: "mes", rotulo: t("Este mês") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex gap-1" role="group" aria-label={t("Período")}>
            {atalhos.map((a) => (
              <Button
                key={a.id}
                size="sm"
                variant={atalho === a.id ? "default" : "outline"}
                onClick={() => escolher(a.id)}
              >
                {a.rotulo}
              </Button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("De")}
            <input
              type="date"
              value={periodo.de}
              onChange={(e) => {
                setAtalho("livre");
                setPeriodo((v) => ({ ...v, de: e.target.value }));
              }}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Até")}
            <input
              type="date"
              value={periodo.ate}
              onChange={(e) => {
                setAtalho("livre");
                setPeriodo((v) => ({ ...v, ate: e.target.value }));
              }}
              className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
            />
          </label>
        </div>
        <div className="flex gap-2">
          {podeLancarGasto ? (
            <Button variant="outline" onClick={() => setGastoAberto(true)}>
              {t("Lançar gasto do dia")}
            </Button>
          ) : null}
          {podeVender ? <Button onClick={() => setVendaAberta(true)}>{t("Registrar venda")}</Button> : null}
        </div>
      </div>

      {painel.isError ? <p className="text-sm text-error-fg">{t("Não foi possível carregar o período.")}</p> : null}

      {p ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" data-testid="cartoes-do-painel">
            <Cartao titulo={t("Faturamento")} valor={formatCents(p.faturamento_cents, "BRL")} destaque />
            <Cartao titulo={t("Vendas")} valor={String(p.vendas)} />
            <Cartao titulo={t("Ticket médio")} valor={formatCents(p.ticket_medio_cents, "BRL")} />
            <Cartao titulo={t("Gasto em anúncio")} valor={formatCents(p.gasto_cents, "BRL")} />
            <Cartao
              titulo={t("ROAS")}
              valor={formatarRoas(p.roas === null ? null : Number(p.roas))}
              destaque
              dica={p.roas === null ? t("Lance o gasto do Meta para ver o retorno.") : t("Faturamento ÷ gasto em anúncio")}
            />
            <Cartao
              titulo={t("Custo por venda")}
              valor={p.custo_por_venda_cents === null ? "—" : formatCents(p.custo_por_venda_cents, "BRL")}
            />
          </div>

          <p className="text-xs text-text-muted" data-testid="origem-das-vendas">
            {t("Registradas")}: {p.por_origem.registradas.vendas} · {t("Funil")}: {p.por_origem.funil.vendas} ·{" "}
            {t("Comandas")}: {p.por_origem.comandas.vendas}
          </p>

          <section className="rounded-md border border-border p-3">
            <h2 className="mb-2 text-sm font-semibold">{t("Faturamento e gasto por dia")}</h2>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={p.por_dia.map((d) => ({ ...d, fat: d.faturamento_cents / 100, gasto: d.gasto_cents / 100 }))}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="dia" tickFormatter={diaCurto} fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip
                    labelFormatter={(v) => diaCurto(String(v))}
                    formatter={(v) => formatCents(Math.round(Number(v) * 100), "BRL")}
                  />
                  <Legend />
                  <Bar dataKey="fat" name={t("Faturamento")} fill="var(--color-accent)" />
                  <Bar dataKey="gasto" name={t("Gasto em anúncio")} fill="var(--color-warning)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-md border border-border p-3">
            <h2 className="mb-2 text-sm font-semibold">{t("Dia a dia")}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-text-muted">
                  <tr>
                    <th className="py-1">{t("Dia")}</th>
                    <th className="py-1 text-right">{t("Vendas")}</th>
                    <th className="py-1 text-right">{t("Faturamento")}</th>
                    <th className="py-1 text-right">{t("Gasto em anúncio")}</th>
                    <th className="py-1 text-right">{t("ROAS")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...p.por_dia].reverse().map((d) => (
                    <tr key={d.dia} className="border-b border-border/60">
                      <td className="py-1">{diaCurto(d.dia)}</td>
                      <td className="py-1 text-right tabular-nums">{d.vendas}</td>
                      <td className="py-1 text-right tabular-nums">{formatCents(d.faturamento_cents, "BRL")}</td>
                      <td className="py-1 text-right tabular-nums">{formatCents(d.gasto_cents, "BRL")}</td>
                      <td className="py-1 text-right tabular-nums">
                        {formatarRoas(d.gasto_cents > 0 ? d.faturamento_cents / d.gasto_cents : null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      <section className="rounded-md border border-border p-3">
        <h2 className="mb-2 text-sm font-semibold">{t("Vendas registradas no período")}</h2>
        {(vendas.data ?? []).length === 0 ? (
          <p className="text-sm text-text-muted">{t("Nenhuma venda registrada no período.")}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {(vendas.data ?? []).map((v) => (
                <tr key={v.id} className={`border-b border-border/60 ${v.status === "reversed" ? "text-text-muted line-through" : ""}`}>
                  <td className="py-1">{diaCurto(v.sold_on)}</td>
                  <td className="py-1">{v.description ?? "—"}</td>
                  <td className="py-1 text-text-muted">{rotuloOrigem(v.origin)}</td>
                  <td className="py-1 text-right tabular-nums">{v.quantity}×</td>
                  <td className="py-1 text-right tabular-nums">{formatCents(v.amount_cents, "BRL")}</td>
                  <td className="py-1 text-right">
                    {podeVender && v.status === "active" && v.origin === "manual" ? (
                      <Button size="sm" variant="ghost" onClick={() => estornar.mutate(v.id)}>
                        {t("Estornar")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RegistrarVendaDialog open={vendaAberta} onOpenChange={setVendaAberta} />
      <LancarGastoDialog open={gastoAberto} onOpenChange={setGastoAberto} />
    </div>
  );
}

function Cartao({ titulo, valor, destaque, dica }: { titulo: string; valor: string; destaque?: boolean; dica?: string }) {
  return (
    <div className="rounded-md border border-border p-3" title={dica}>
      <p className="text-xs text-text-muted">{titulo}</p>
      <p className={`tabular-nums ${destaque ? "text-xl font-semibold" : "text-lg"}`}>{valor}</p>
      {dica ? <p className="mt-1 text-[11px] text-text-muted">{dica}</p> : null}
    </div>
  );
}

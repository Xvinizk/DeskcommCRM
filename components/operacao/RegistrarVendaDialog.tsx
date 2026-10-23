"use client";
/**
 * Registrar venda — o mesmo diálogo na ficha do contato e no painel.
 *
 * Só VALOR e QUANTIDADE ficam à vista: "fiz 3 vendas hoje, R$ 300" se lança em
 * dois campos. O resto (data, o que foi vendido, forma de pagamento, contato)
 * fica atrás de "Adicionar detalhes", porque é opcional e quem tem pressa não
 * precisa ver. Na ficha do contato, o contato já vem escolhido.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { parseReaisToCents } from "@/lib/money";

type Forma = { id: string; name: string };
type Contato = { id: string; display_name: string | null; name: string | null };

const hojeLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function RegistrarVendaDialog({
  open,
  onOpenChange,
  contactId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Na ficha do contato: a venda já nasce ligada a ele. */
  contactId?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [valor, setValor] = useState("");
  const [quantidade, setQuantidade] = useState("1");
  const [detalhes, setDetalhes] = useState(false);
  const [data, setData] = useState(hojeLocal);
  const [descricao, setDescricao] = useState("");
  const [forma, setForma] = useState("");
  const [contato, setContato] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const formas = useQuery({
    queryKey: ["financeiro", "catalogo", "formas_de_pagamento"],
    queryFn: async () => (await apiClient.get<{ data: Forma[] }>("/api/v1/financeiro/catalogo/formas_de_pagamento")).data,
    enabled: open && detalhes,
  });
  const contatos = useQuery({
    queryKey: ["contacts", "para-venda"],
    queryFn: async () => (await apiClient.get<{ data: Contato[] }>("/api/v1/contacts?limit=100")).data,
    enabled: open && detalhes && !contactId,
  });

  const limpar = () => {
    setValor("");
    setQuantidade("1");
    setDetalhes(false);
    setData(hojeLocal());
    setDescricao("");
    setForma("");
    setContato("");
    setErro(null);
  };

  const registrar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) => apiClient.post("/api/v1/operacao/vendas", corpo),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["operacao"] });
      limpar();
      onOpenChange(false);
    },
    onError: showApiError,
  });

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    const cents = parseReaisToCents(valor);
    const qtd = Number(quantidade);
    if (!cents || cents <= 0) return setErro(t("Informe o valor da venda."));
    if (!Number.isInteger(qtd) || qtd < 1) return setErro(t("A quantidade precisa ser um número inteiro a partir de 1."));
    setErro(null);
    const alvo = contactId ?? (contato || undefined);
    registrar.mutate({
      amount_cents: cents,
      quantity: qtd,
      sold_on: data,
      ...(descricao.trim() ? { description: descricao.trim() } : {}),
      ...(forma ? { payment_method_id: forma } : {}),
      ...(alvo ? { contact_id: alvo } : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) limpar();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Registrar venda")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={enviar} className="flex flex-col gap-3" data-testid="form-registrar-venda">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="venda-valor">{t("Valor total (R$)")}</Label>
              <Input
                id="venda-valor"
                inputMode="decimal"
                placeholder="300,00"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="venda-qtd">{t("Quantidade de vendas")}</Label>
              <Input
                id="venda-qtd"
                inputMode="numeric"
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
              />
            </div>
          </div>

          {!detalhes ? (
            <button
              type="button"
              className="self-start text-sm text-accent underline-offset-2 hover:underline"
              onClick={() => setDetalhes(true)}
            >
              {t("Adicionar detalhes (opcional)")}
            </button>
          ) : (
            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="venda-data">{t("Data da venda")}</Label>
                <Input id="venda-data" type="date" value={data} onChange={(e) => setData(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="venda-desc">{t("O que foi vendido")}</Label>
                <Input
                  id="venda-desc"
                  maxLength={300}
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="venda-forma">{t("Forma de pagamento")}</Label>
                <select
                  id="venda-forma"
                  value={forma}
                  onChange={(e) => setForma(e.target.value)}
                  className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                >
                  <option value="">{t("Não informar")}</option>
                  {(formas.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              {!contactId ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="venda-contato">{t("Contato")}</Label>
                  <select
                    id="venda-contato"
                    value={contato}
                    onChange={(e) => setContato(e.target.value)}
                    className="rounded-md border border-border bg-surface-elevated p-2 text-sm text-text"
                  >
                    <option value="">{t("Sem contato")}</option>
                    {(contatos.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {rotuloDoContato(c, t)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          )}

          {erro ? <p className="text-sm text-error-fg">{erro}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={registrar.isPending}>
              {t("Registrar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

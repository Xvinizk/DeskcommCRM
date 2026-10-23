"use client";
/**
 * Lançar o gasto do dia no Meta. Substitui o valor do dia, não soma: quem
 * corrige "gastei 150, não 100" espera ver 150.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { parseReaisToCents } from "@/lib/money";

const hojeLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function LancarGastoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [dia, setDia] = useState(hojeLocal);
  const [valor, setValor] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const lancar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) => apiClient.put("/api/v1/operacao/gastos", corpo),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["operacao"] });
      setValor("");
      onOpenChange(false);
    },
    onError: showApiError,
  });

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    const cents = valor.trim() === "0" ? 0 : parseReaisToCents(valor);
    if (cents === null || cents < 0) return setErro(t("Informe quanto foi gasto no dia."));
    setErro(null);
    lancar.mutate({ spend_date: dia, amount_cents: cents });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Lançar gasto no Meta Ads")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={enviar} className="flex flex-col gap-3" data-testid="form-lancar-gasto">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="gasto-dia">{t("Dia")}</Label>
              <Input id="gasto-dia" type="date" value={dia} onChange={(e) => setDia(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="gasto-valor">{t("Gasto do dia (R$)")}</Label>
              <Input
                id="gasto-valor"
                inputMode="decimal"
                placeholder="150,00"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <p className="text-xs text-text-muted">{t("Se já houver um valor para este dia, ele é substituído.")}</p>
          {erro ? <p className="text-sm text-error-fg">{erro}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={lancar.isPending}>
              {t("Salvar gasto")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

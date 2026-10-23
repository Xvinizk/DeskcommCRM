import { describe, expect, it } from "vitest";

import { formatarRoas, gastoSchema, periodoValido, vendaSchema } from "./contratos";

describe("vendaSchema", () => {
  it("só valor é obrigatório; quantidade nasce 1", () => {
    const r = vendaSchema.parse({ amount_cents: 15000, sold_on: "2026-10-22" });
    expect(r.quantity).toBe(1);
    expect(r.contact_id).toBeUndefined();
  });

  it("aceita o lote rápido: 3 vendas, R$ 300", () => {
    expect(vendaSchema.parse({ amount_cents: 30000, quantity: 3, sold_on: "2026-10-22" }).quantity).toBe(3);
  });

  it("recusa valor zero, negativo ou fracionado", () => {
    for (const amount_cents of [0, -1, 10.5]) {
      expect(vendaSchema.safeParse({ amount_cents, sold_on: "2026-10-22" }).success).toBe(false);
    }
  });

  it("recusa data fora do formato e descrição longa", () => {
    expect(vendaSchema.safeParse({ amount_cents: 100, sold_on: "22/10/2026" }).success).toBe(false);
    expect(vendaSchema.safeParse({ amount_cents: 100, sold_on: "2026-10-22", description: "x".repeat(301) }).success).toBe(false);
  });

  it("não aceita escolher a origem pelo corpo", () => {
    const r = vendaSchema.parse({ amount_cents: 100, sold_on: "2026-10-22", origin: "lead_won" } as never);
    expect("origin" in r).toBe(false);
  });
});

describe("gastoSchema", () => {
  it("aceita gasto zero (dia sem anúncio) e recusa negativo", () => {
    expect(gastoSchema.safeParse({ spend_date: "2026-10-22", amount_cents: 0 }).success).toBe(true);
    expect(gastoSchema.safeParse({ spend_date: "2026-10-22", amount_cents: -5 }).success).toBe(false);
  });
});

describe("periodoValido", () => {
  it("aceita um dia só", () => {
    expect(periodoValido("2026-10-22", "2026-10-22")).toEqual({ ok: true, de: "2026-10-22", ate: "2026-10-22" });
  });

  it("recusa início depois do fim", () => {
    expect(periodoValido("2026-10-23", "2026-10-22").ok).toBe(false);
  });

  it("recusa mais de 366 dias", () => {
    expect(periodoValido("2025-01-01", "2026-10-22").ok).toBe(false);
    expect(periodoValido("2025-10-22", "2026-10-22").ok).toBe(true);
  });

  it("recusa data ausente ou inválida", () => {
    expect(periodoValido(null, "2026-10-22").ok).toBe(false);
    expect(periodoValido("2026-02-30", "2026-03-01").ok).toBe(false);
  });
});

describe("formatarRoas", () => {
  it("sem gasto não há ROAS", () => {
    expect(formatarRoas(null)).toBe("—");
  });

  it("formata com vírgula e 'x'", () => {
    expect(formatarRoas(3.25)).toBe("3,25x");
    expect(formatarRoas(4)).toBe("4,00x");
  });
});

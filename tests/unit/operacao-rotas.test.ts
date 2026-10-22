/**
 * As rotas do painel da operação, com o Zod, o `ok()`/`fail()` e o handler de
 * verdade. Só as fronteiras são dublês: sessão (`requireRole`), PostgREST e
 * audit.
 *
 * O que se mede: a origem da venda não vem do corpo; a descrição (texto livre,
 * pode nomear a pessoa) não vai para o audit, que é append-only e fora do
 * alcance da LGPD; venda do funil não se estorna pela tela; gasto é de gestor.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

interface EventoDeAudit {
  action: string;
  metadata?: Record<string, unknown>;
}
const auditSpy = vi.fn(async (_evento: EventoDeAudit) => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "0a000389-0000-4000-8000-000000000001";
const USUARIO = "0a000389-0000-4000-8000-0000000000a1";
const VENDA = "0a000389-0000-4000-8000-0000000000b1";

type Resposta = { data: unknown; error: unknown };
const gravados: { tabela: string; op: string; linha: Record<string, unknown> }[] = [];
let rpcArgs: Record<string, unknown> | null = null;

function supabaseFake(respostas: Record<string, Resposta>) {
  const cadeia = (tabela: string) => {
    const r = respostas[tabela] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      lte: () => c,
      order: () => c,
      limit: () => c,
      insert: (linha: Record<string, unknown>) => (gravados.push({ tabela, op: "insert", linha }), c),
      update: (linha: Record<string, unknown>) => (gravados.push({ tabela, op: "update", linha }), c),
      upsert: (linha: Record<string, unknown>) => (gravados.push({ tabela, op: "upsert", linha }), c),
      maybeSingle: async () => r,
      single: async () => r,
      then: (resolve: (v: Resposta) => unknown) => resolve(r),
    };
    return c;
  };
  return {
    from: cadeia,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcArgs = args;
      return respostas[`rpc:${fn}`] ?? { data: null, error: null };
    },
  };
}

function sessao(respostas: Record<string, Resposta> = {}) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USUARIO,
      email: "gerente@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "manager" }],
    },
    org: { orgId: ORG, name: "Org", role: "manager" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabaseFake(respostas) as any);
}

const corpo = (url: string, metodo: string, body?: unknown) =>
  new NextRequest(url, { method: metodo, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  vi.clearAllMocks();
  gravados.length = 0;
  rpcArgs = null;
});

describe("POST /api/v1/operacao/vendas", () => {
  it("corpo inválido → 422", async () => {
    sessao();
    const { POST } = await import("@/app/api/v1/operacao/vendas/route");
    const res = await POST(corpo("http://x/api/v1/operacao/vendas", "POST", { amount_cents: 0, sold_on: "2026-10-22" }));
    expect(res.status).toBe(422);
  });

  it("grava origin 'manual' mesmo que o corpo diga 'lead_won', na org da sessão", async () => {
    sessao({ operation_sales: { data: { id: VENDA, amount_cents: 30000, quantity: 3, sold_on: "2026-10-22" }, error: null } });
    const { POST } = await import("@/app/api/v1/operacao/vendas/route");
    const res = await POST(
      corpo("http://x/api/v1/operacao/vendas", "POST", {
        amount_cents: 30000,
        quantity: 3,
        sold_on: "2026-10-22",
        origin: "lead_won",
        organization_id: "ffffffff-0000-4000-8000-000000000000",
      }),
    );
    expect(res.status).toBe(201);
    const insert = gravados.find((g) => g.tabela === "operation_sales" && g.op === "insert");
    expect(insert?.linha.origin).toBe("manual");
    expect(insert?.linha.organization_id).toBe(ORG);
    expect(insert?.linha.created_by_user_id).toBe(USUARIO);
  });

  it("a descrição não vai para o audit — o audit foi chamado", async () => {
    const frase = "ensaio da Marta, que está grávida de gêmeos";
    sessao({ operation_sales: { data: { id: VENDA, amount_cents: 15000, quantity: 1, sold_on: "2026-10-22" }, error: null } });
    const { POST } = await import("@/app/api/v1/operacao/vendas/route");
    await POST(corpo("http://x/api/v1/operacao/vendas", "POST", { amount_cents: 15000, sold_on: "2026-10-22", description: frase }));
    const evento = auditSpy.mock.calls.map(([e]) => e).find((e) => e.action === "operacao.venda_registrada");
    expect(evento).toBeDefined();
    expect(JSON.stringify(evento)).not.toContain(frase);
  });

  it("sem papel → a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const { POST } = await import("@/app/api/v1/operacao/vendas/route");
    const res = await POST(corpo("http://x/api/v1/operacao/vendas", "POST", { amount_cents: 100, sold_on: "2026-10-22" }));
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
  });
});

describe("DELETE /api/v1/operacao/vendas/[id]", () => {
  const ctx = { params: Promise.resolve({ id: VENDA }) };

  it("venda do funil não se estorna pela tela → 409", async () => {
    sessao({ operation_sales: { data: { id: VENDA, origin: "lead_won", status: "active" }, error: null } });
    const { DELETE } = await import("@/app/api/v1/operacao/vendas/[id]/route");
    const res = await DELETE(corpo(`http://x/api/v1/operacao/vendas/${VENDA}`, "DELETE"), ctx);
    expect(res.status).toBe(409);
    expect(gravados.filter((g) => g.op === "update")).toHaveLength(0);
  });

  it("venda manual estorna por status (não apaga) e audita", async () => {
    sessao({ operation_sales: { data: { id: VENDA, origin: "manual", status: "active", amount_cents: 100 }, error: null } });
    const { DELETE } = await import("@/app/api/v1/operacao/vendas/[id]/route");
    const res = await DELETE(corpo(`http://x/api/v1/operacao/vendas/${VENDA}`, "DELETE"), ctx);
    expect(res.status).toBe(200);
    const upd = gravados.find((g) => g.op === "update");
    expect(upd?.linha.status).toBe("reversed");
    expect(auditSpy.mock.calls.map(([e]) => e.action)).toContain("operacao.venda_estornada");
  });

  it("venda inexistente → 404", async () => {
    sessao({ operation_sales: { data: null, error: null } });
    const { DELETE } = await import("@/app/api/v1/operacao/vendas/[id]/route");
    const res = await DELETE(corpo(`http://x/api/v1/operacao/vendas/${VENDA}`, "DELETE"), ctx);
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/v1/operacao/gastos", () => {
  it("é de gestor e grava um valor manual por dia", async () => {
    sessao({ ad_spend_daily: { data: { id: "g1", spend_date: "2026-10-22", amount_cents: 15000 }, error: null } });
    const { PUT } = await import("@/app/api/v1/operacao/gastos/route");
    const res = await PUT(corpo("http://x/api/v1/operacao/gastos", "PUT", { spend_date: "2026-10-22", amount_cents: 15000 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
    const up = gravados.find((g) => g.op === "upsert");
    expect(up?.linha).toMatchObject({ organization_id: ORG, platform: "meta", source: "manual", amount_cents: 15000 });
    expect(auditSpy.mock.calls.map(([e]) => e.action)).toContain("operacao.gasto_lancado");
  });

  it("gasto negativo → 422", async () => {
    sessao();
    const { PUT } = await import("@/app/api/v1/operacao/gastos/route");
    const res = await PUT(corpo("http://x/api/v1/operacao/gastos", "PUT", { spend_date: "2026-10-22", amount_cents: -1 }));
    expect(res.status).toBe(422);
  });
});

describe("GET /api/v1/reports/operacao", () => {
  it("período inválido → 422", async () => {
    sessao();
    const { GET } = await import("@/app/api/v1/reports/operacao/route");
    const res = await GET(corpo("http://x/api/v1/reports/operacao?de=2026-10-23&ate=2026-10-22", "GET"));
    expect(res.status).toBe(422);
  });

  it("devolve o agregado do banco para a org da sessão", async () => {
    sessao({ "rpc:fn_painel_operacao": { data: { vendas: 4, faturamento_cents: 31000 }, error: null } });
    const { GET } = await import("@/app/api/v1/reports/operacao/route");
    const res = await GET(corpo("http://x/api/v1/reports/operacao?de=2026-10-19&ate=2026-10-21", "GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { vendas: number } }).data.vendas).toBe(4);
    expect(rpcArgs).toEqual({ p_org: ORG, p_de: "2026-10-19", p_ate: "2026-10-21" });
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("viewer");
  });
});

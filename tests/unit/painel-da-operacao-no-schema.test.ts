/**
 * O painel da operação no SCHEMA — o que dá para provar sem Postgres.
 *
 * Lê o `baseline.sql` (o que o self-hoster aplica) e a migration 0389, sem
 * comentários: a prosa que explica um invariante é o texto mais parecido com
 * ele, e casar com ela faria o teste passar com o SQL removido (ver
 * `comanda-invariantes-no-schema.test.ts`). O comportamento do gatilho e da
 * RLS é medido em `tests/invariants/painel-da-operacao.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const raiz = join(__dirname, "..", "..");
const semComentarios = (sql: string) => sql.replace(/--[^\n]*/g, "");

const baseline = readFileSync(join(raiz, "supabase", "baseline.sql"), "utf8");
const bloco = (() => {
  const i = baseline.lastIndexOf("-- ---- painel da operação (migration 0389) ----");
  expect(i, "o bloco do painel da operação sumiu do baseline").toBeGreaterThan(-1);
  return semComentarios(baseline.slice(i));
})();

const migration = (() => {
  const nome = readdirSync(join(raiz, "supabase", "migrations")).find((n) => n.includes("_0389_"));
  expect(nome, "migration 0389 ausente").toBeDefined();
  return semComentarios(readFileSync(join(raiz, "supabase", "migrations", nome!), "utf8"));
})();

describe.each([
  ["baseline", () => bloco],
  ["migration", () => migration],
])("painel da operação — %s", (_nome, sqlDe) => {
  it("as duas tabelas existem, por organização", () => {
    const sql = sqlDe();
    for (const t of ["operation_sales", "ad_spend_daily"]) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${t}`));
    }
    expect(sql.match(/organization_id uuid not null references public\.organizations\(id\) on delete cascade/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("dinheiro é centavo inteiro e positivo na venda", () => {
    expect(sqlDe()).toMatch(/amount_cents bigint not null check \(amount_cents > 0\)/);
    expect(sqlDe()).toMatch(/quantity integer not null default 1 check \(quantity > 0\)/);
  });

  it("venda não se apaga: estorna por status", () => {
    expect(sqlDe()).toMatch(/status text not null default 'active'\s+check \(status in \('active', 'reversed'\)\)/);
  });

  it("um lead tem no máximo UMA venda automática", () => {
    expect(sqlDe()).toMatch(
      /create unique index if not exists operation_sales_um_por_lead\s+on public\.operation_sales \(organization_id, lead_id\)\s+where lead_id is not null/,
    );
  });

  it("um gasto manual por dia e plataforma", () => {
    expect(sqlDe()).toMatch(/unique \(organization_id, spend_date, platform, source\)/);
    expect(sqlDe()).toMatch(/platform text not null default 'meta'\s+check \(platform in \('meta'\)\)/);
  });

  it("RLS ligada nas duas, escrita do gasto só para gestor", () => {
    const sql = sqlDe();
    expect(sql).toMatch(/alter table public\.operation_sales enable row level security/);
    expect(sql).toMatch(/alter table public\.ad_spend_daily enable row level security/);
    expect(sql).toMatch(/create policy tenant_isolation_ad_spend_daily_all[\s\S]*?fn_role_at_least\(organization_id, 'manager'\)/);
    expect(sql).toMatch(/create policy tenant_isolation_operation_sales_all[\s\S]*?fn_role_at_least\(organization_id, 'agent'\)/);
  });

  it("o gatilho do lead ganho existe e não faz HTTP", () => {
    const sql = sqlDe();
    expect(sql).toMatch(/create trigger trg_venda_do_lead_ganho\s+after insert or update of status, value_cents, currency, closed_at, contact_id on public\.crm_leads/);
    const corpo = sql.slice(sql.lastIndexOf("create or replace function public.fn_sincronizar_venda_do_lead"));
    expect(corpo).not.toMatch(/net\.http|http_post|pg_net/);
    expect(corpo).toMatch(/on conflict \(organization_id, lead_id\) where lead_id is not null/);
  });

  it("funções novas revogadas de public e anon", () => {
    const sql = sqlDe();
    expect(sql).toMatch(/revoke execute on function public\.fn_sincronizar_venda_do_lead\(\) from public, anon/);
    expect(sql).toMatch(/revoke execute on function public\.fn_painel_operacao\(uuid, date, date\) from public, anon/);
  });

  it("o painel conta dia no fuso da organização e não conta comanda estornada", () => {
    const corpo = sqlDe().slice(sqlDe().lastIndexOf("create or replace function public.fn_painel_operacao"));
    expect(corpo).toMatch(/at time zone/);
    expect(corpo).toMatch(/reversed_at is null/);
    expect(corpo).toMatch(/generate_series/);
  });
});

describe("MANIFEST", () => {
  it("registra a 0389", () => {
    const manifest = readFileSync(join(raiz, "supabase", "migrations", "MANIFEST.md"), "utf8");
    expect(manifest).toMatch(/0389/);
  });
});

import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PAINEL DA OPERAÇÃO — o gatilho do lead ganho, o agregado e a RLS, num
 * Postgres de verdade (baseline aplicado por `scripts/test-db.sh`).
 *
 * O que só o banco prova: que arrastar o lead para Ganho duas vezes não cria
 * duas vendas, que sair de Ganho estorna e voltar reativa a MESMA linha, que a
 * venda das 23h30 de São Paulo cai no dia certo, e que uma organização não lê
 * nem escreve a venda da outra.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}
const ultima = (out: string) => out.split("\n").pop() ?? "";
const noBanco = (script: string) => ultima(sql(`reset role;\n${script}`));
function comoUsuario(userId: string, script: string): string {
  return ultima(
    sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `),
  );
}

const ORG_A = "eeeeeeee-0389-4000-8000-00000000000a";
const ORG_B = "eeeeeeee-0389-4000-8000-00000000000b";
const AGENT_A = "eeeeeeee-0389-4000-8000-0000000000a1";
const AGENT_B = "eeeeeeee-0389-4000-8000-0000000000b1";
const PIPE = "eeeeeeee-0389-4000-8000-0000000000f1";
const ABERTA = "eeeeeeee-0389-4000-8000-0000000000f2";
const GANHO = "eeeeeeee-0389-4000-8000-0000000000f3";
const LEAD = "eeeeeeee-0389-4000-8000-0000000000c1";

const vendasDoLead = () =>
  noBanco(`select count(*) || ':' || coalesce(string_agg(status || '/' || amount_cents, ','), '') from public.operation_sales where lead_id = '${LEAD}';`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'painel-a@invariant.test'), ('${AGENT_B}', 'painel-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, timezone) values
      ('${ORG_A}', 'painel-inv-a', 'Painel A', 'Painel A', 'America/Sao_Paulo'),
      ('${ORG_B}', 'painel-inv-b', 'Painel B', 'Painel B', 'America/Sao_Paulo')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()), ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE}', '${ORG_A}', 'Funil', 'funil-painel') on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values
      ('${ABERTA}', '${ORG_A}', '${PIPE}', 'Aberta', 'aberta-painel', 1, false),
      ('${GANHO}',  '${ORG_A}', '${PIPE}', 'Ganho',  'ganho-painel',  2, true)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, value_cents) values
      ('${LEAD}', '${ORG_A}', '${PIPE}', '${ABERTA}', 'Ensaio', 15000) on conflict (id) do nothing;
  `);
});

describe("venda do lead ganho", () => {
  it("ganhar cria UMA venda com o valor do lead", () => {
    noBanco(`update public.crm_leads set status = 'won', closed_at = now() where id = '${LEAD}';`);
    expect(vendasDoLead()).toBe("1:active/15000");
  });

  it("mexer de novo no lead ganho não duplica — atualiza o valor", () => {
    noBanco(`update public.crm_leads set value_cents = 20000 where id = '${LEAD}';`);
    noBanco(`update public.crm_leads set status = 'won', closed_at = now() where id = '${LEAD}';`);
    expect(vendasDoLead()).toBe("1:active/20000");
  });

  it("sair de Ganho estorna", () => {
    noBanco(`update public.crm_leads set status = 'open', closed_at = null where id = '${LEAD}';`);
    expect(vendasDoLead()).toBe("1:reversed/20000");
  });

  it("voltar a ganhar reativa a MESMA linha", () => {
    noBanco(`update public.crm_leads set status = 'won', closed_at = now(), value_cents = 25000 where id = '${LEAD}';`);
    expect(vendasDoLead()).toBe("1:active/25000");
  });

  it("zerar o valor com o lead em Ganho estorna", () => {
    noBanco(`update public.crm_leads set value_cents = null where id = '${LEAD}';`);
    expect(vendasDoLead()).toBe("1:reversed/25000");
  });

  it("23h30 em São Paulo cai no dia de São Paulo, não no seguinte em UTC", () => {
    noBanco(`update public.crm_leads set value_cents = 1000, closed_at = '2026-10-21T23:30:00-03:00' where id = '${LEAD}';`);
    expect(noBanco(`select sold_on from public.operation_sales where lead_id = '${LEAD}';`)).toBe("2026-10-21");
  });
});

describe("fn_painel_operacao", () => {
  it("soma registradas + funil, conta quantidade, ROAS e dia sem buraco", () => {
    noBanco(`
      delete from public.operation_sales where organization_id = '${ORG_A}' and origin = 'manual';
      insert into public.operation_sales (organization_id, sold_on, quantity, amount_cents) values
        ('${ORG_A}', '2026-10-20', 3, 30000);
      insert into public.ad_spend_daily (organization_id, spend_date, amount_cents) values
        ('${ORG_A}', '2026-10-20', 10000)
        on conflict (organization_id, spend_date, platform, source) do update set amount_cents = excluded.amount_cents;
    `);
    const r = JSON.parse(noBanco(`select public.fn_painel_operacao('${ORG_A}', '2026-10-19', '2026-10-21')::text;`));
    expect(r.vendas).toBe(4);
    expect(r.faturamento_cents).toBe(31000);
    expect(r.ticket_medio_cents).toBe(7750);
    expect(r.gasto_cents).toBe(10000);
    expect(Number(r.roas)).toBe(3.1);
    expect(r.por_dia.map((d: { dia: string }) => d.dia)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(r.por_origem.registradas.vendas).toBe(3);
    expect(r.por_origem.funil.vendas).toBe(1);
  });

  it("sem gasto, ROAS é nulo — nunca divisão por zero", () => {
    const r = JSON.parse(noBanco(`select public.fn_painel_operacao('${ORG_A}', '2026-10-21', '2026-10-21')::text;`));
    expect(r.roas).toBeNull();
  });
});

describe("isolamento entre organizações", () => {
  it("a organização B não lê a venda da A", () => {
    expect(comoUsuario(AGENT_B, `select count(*) from public.operation_sales where organization_id = '${ORG_A}';`)).toBe("0");
    expect(comoUsuario(AGENT_A, `select count(*) from public.operation_sales where organization_id = '${ORG_A}';`)).not.toBe("0");
  });

  it("a organização B não grava venda na A", () => {
    expect(() =>
      comoUsuario(AGENT_B, `insert into public.operation_sales (organization_id, sold_on, amount_cents) values ('${ORG_A}', '2026-10-21', 100);`),
    ).toThrow();
  });

  it("agent não lança gasto — é de gestor", () => {
    expect(() =>
      comoUsuario(AGENT_A, `insert into public.ad_spend_daily (organization_id, spend_date, amount_cents) values ('${ORG_A}', '2026-10-22', 100);`),
    ).toThrow();
  });
});

-- 0389 — painel da operação: venda registrada, gasto diário em anúncio e o
-- agregado que responde faturamento, ticket médio, gasto e ROAS por dia.
--
-- Por que `operation_sales` e não a comanda (`sales`): a comanda exige forma
-- de pagamento para finalizar (`sales_finalizada_tem_forma`), e por trás dela
-- uma conta financeira. Quem registra "vendi tal coisa" ou "fiz 3 vendas hoje"
-- quer esses dados OPCIONAIS. O painel soma as duas fontes e mostra a origem;
-- a comanda nunca gera linha aqui, então nada é contado duas vezes.
--
-- Idempotente: create ... if not exists, create or replace, drop ... if exists.

-- ─── a venda registrada ──────────────────────────────────────────────────────
create table if not exists public.operation_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- O DIA da venda, já no fuso da organização. Data e não instante: "fiz 3
  -- vendas hoje" não tem hora, e guardar meia-noite UTC jogaria a venda no
  -- dia anterior para quem está em São Paulo.
  sold_on date not null,

  -- "3 vendas, R$ 300" é UMA linha com quantity = 3. Ticket médio é soma dos
  -- valores ÷ soma das quantidades.
  quantity integer not null default 1 check (quantity > 0),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),

  description text check (description is null or char_length(description) <= 300),
  contact_id uuid references public.contacts(id) on delete set null,
  -- A venda do lead ganho. `set null`: apagar o lead não desfaz a venda.
  lead_id uuid references public.crm_leads(id) on delete set null,
  payment_method_id uuid references public.payment_methods(id) on delete set null,

  -- Quem gerou. `lead_won` só nasce do gatilho abaixo — a rota grava `manual`
  -- fixo, nunca o que vem do corpo.
  origin text not null default 'manual' check (origin in ('manual', 'lead_won')),

  -- Venda não se apaga: estorna.
  status text not null default 'active'
    check (status in ('active', 'reversed')),
  reversed_at timestamptz,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists operation_sales_um_por_lead
  on public.operation_sales (organization_id, lead_id)
  where lead_id is not null;
create index if not exists operation_sales_org_dia_idx
  on public.operation_sales (organization_id, sold_on desc);
create index if not exists operation_sales_org_contato_idx
  on public.operation_sales (organization_id, contact_id)
  where contact_id is not null;

-- ─── o gasto em anúncio, por dia ─────────────────────────────────────────────
create table if not exists public.ad_spend_daily (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  spend_date date not null,
  -- Só Meta na v1. `text` + CHECK, não enum: Google entra estendendo o CHECK.
  platform text not null default 'meta'
    check (platform in ('meta')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  -- `meta_sync` fica reservado para a sincronização automática. No dia em que
  -- houver os dois, o painel usa o sincronizado.
  source text not null default 'manual' check (source in ('manual', 'meta_sync')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, spend_date, platform, source)
);

-- ─── RLS: membro lê; venda escreve `agent`, gasto escreve `manager` ──────────
alter table public.operation_sales enable row level security;
drop policy if exists tenant_isolation_operation_sales_all on public.operation_sales;
create policy tenant_isolation_operation_sales_all on public.operation_sales
  for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'agent'))
  );
revoke all on public.operation_sales from anon;

alter table public.ad_spend_daily enable row level security;
drop policy if exists tenant_isolation_ad_spend_daily_all on public.ad_spend_daily;
create policy tenant_isolation_ad_spend_daily_all on public.ad_spend_daily
  for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );
revoke all on public.ad_spend_daily from anon;

-- ─── a venda do lead ganho ───────────────────────────────────────────────────
-- Gatilho que só escreve no banco (nunca HTTP). Uma linha por lead, garantida
-- pelo índice único parcial: ganhar de novo REATIVA a mesma linha; sair de
-- Ganho (ou zerar o valor) a estorna. Sem valor, não há venda.
create or replace function public.fn_sincronizar_venda_do_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  if new.status = 'won' and coalesce(new.value_cents, 0) > 0 then
    select o.timezone into v_tz from public.organizations o where o.id = new.organization_id;
    -- Fuso inválido não pode travar o arrasto do lead: cai no padrão.
    if v_tz is null or not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
      v_tz := 'America/Sao_Paulo';
    end if;

    insert into public.operation_sales
      (organization_id, sold_on, quantity, amount_cents, currency, contact_id, lead_id, origin, status)
    values
      (new.organization_id,
       (coalesce(new.closed_at, now()) at time zone v_tz)::date,
       1, new.value_cents, coalesce(new.currency, 'BRL'), new.contact_id, new.id, 'lead_won', 'active')
    on conflict (organization_id, lead_id) where lead_id is not null
    do update set
      sold_on      = excluded.sold_on,
      amount_cents = excluded.amount_cents,
      currency     = excluded.currency,
      contact_id   = excluded.contact_id,
      status       = 'active',
      reversed_at  = null,
      updated_at   = now();
  elsif tg_op = 'UPDATE' then
    update public.operation_sales
       set status = 'reversed', reversed_at = now(), updated_at = now()
     where organization_id = new.organization_id
       and lead_id = new.id
       and status = 'active';
  end if;
  return new;
end $$;

-- Função de GATILHO: ninguém a chama direto. `authenticated` também sai — o
-- default ACL do baseline lhe daria EXECUTE, e o gatilho dispara sem precisar dele.
revoke execute on function public.fn_sincronizar_venda_do_lead() from public, anon, authenticated;

drop trigger if exists trg_venda_do_lead_ganho on public.crm_leads;
create trigger trg_venda_do_lead_ganho
  after insert or update of status, value_cents, currency, closed_at, contact_id on public.crm_leads
  for each row execute function public.fn_sincronizar_venda_do_lead();

-- ─── o agregado do painel ────────────────────────────────────────────────────
-- Agrega NO BANCO pelo mesmo motivo de `fn_relatorio_financeiro`: o PostgREST
-- corta em 1000 linhas sem avisar. Invoker: a RLS de cada tabela vale.
create or replace function public.fn_painel_operacao(
  p_org uuid,
  p_de date,
  p_ate date
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with fuso as (
    select coalesce((
      select o.timezone from public.organizations o
       where o.id = p_org
         and exists (select 1 from pg_timezone_names z where z.name = o.timezone)
    ), 'America/Sao_Paulo') as tz
  ),
  dias as (
    select d::date as dia from generate_series(p_de, p_ate, interval '1 day') d
  ),
  vendas as (
    select v.sold_on as dia,
           v.quantity::bigint as vendas,
           v.amount_cents,
           case when v.origin = 'lead_won' then 'funil' else 'registradas' end as origem
      from public.operation_sales v
     where v.organization_id = p_org
       and v.status = 'active'
       and v.sold_on between p_de and p_ate
    union all
    select (s.finalized_at at time zone f.tz)::date,
           1::bigint,
           s.total_cents,
           'comandas'
      from public.sales s
     cross join fuso f
     where s.organization_id = p_org
       and s.status = 'finalized'
       and s.finalized_at is not null
       and s.reversed_at is null
       and (s.finalized_at at time zone f.tz)::date between p_de and p_ate
  ),
  gastos as (
    select g.spend_date as dia,
           case when bool_or(g.source = 'meta_sync')
                then sum(g.amount_cents) filter (where g.source = 'meta_sync')
                else sum(g.amount_cents) filter (where g.source = 'manual')
           end as gasto_cents
      from public.ad_spend_daily g
     where g.organization_id = p_org
       and g.spend_date between p_de and p_ate
     group by g.spend_date
  ),
  serie as (
    select d.dia,
           coalesce(v.vendas, 0)::bigint            as vendas,
           coalesce(v.faturamento_cents, 0)::bigint as faturamento_cents,
           coalesce(g.gasto_cents, 0)::bigint       as gasto_cents
      from dias d
      left join (
        select dia, sum(vendas) as vendas, sum(amount_cents) as faturamento_cents
          from vendas group by dia
      ) v on v.dia = d.dia
      left join gastos g on g.dia = d.dia
  ),
  tot as (
    select coalesce(sum(vendas), 0)::bigint            as vendas,
           coalesce(sum(faturamento_cents), 0)::bigint as fat,
           coalesce(sum(gasto_cents), 0)::bigint       as gasto
      from serie
  )
  select jsonb_build_object(
    'de', p_de,
    'ate', p_ate,
    'fuso', (select tz from fuso),
    'faturamento_cents', t.fat,
    'vendas', t.vendas,
    'gasto_cents', t.gasto,
    'ticket_medio_cents', case when t.vendas > 0 then t.fat / t.vendas else 0 end,
    'roas', case when t.gasto > 0 then round(t.fat::numeric / t.gasto, 2) end,
    'custo_por_venda_cents', case when t.vendas > 0 then t.gasto / t.vendas end,
    'por_origem', (
      select jsonb_object_agg(o.origem, jsonb_build_object(
               'vendas', coalesce((select sum(x.vendas) from vendas x where x.origem = o.origem), 0),
               'faturamento_cents', coalesce((select sum(x.amount_cents) from vendas x where x.origem = o.origem), 0)))
        from (values ('registradas'), ('funil'), ('comandas')) o(origem)
    ),
    'por_dia', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'dia', s.dia,
               'vendas', s.vendas,
               'faturamento_cents', s.faturamento_cents,
               'gasto_cents', s.gasto_cents) order by s.dia), '[]'::jsonb)
        from serie s
    )
  )
  from tot t;
$$;

revoke execute on function public.fn_painel_operacao(uuid, date, date) from public, anon;
grant  execute on function public.fn_painel_operacao(uuid, date, date) to authenticated, service_role;

comment on table public.operation_sales is
  'Venda registrada (manual ou do lead ganho). Estorna por status, nunca apaga. Uma por lead.';
comment on table public.ad_spend_daily is
  'Gasto em anúncio por dia. Um valor por (dia, plataforma, origem); sincronizado vence manual.';

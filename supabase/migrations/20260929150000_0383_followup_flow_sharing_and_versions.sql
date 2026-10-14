-- 0383 — Compartilhamento de Fluxos, Versionamento e Backups
--
-- 1. followup_flow_versions ganha label e kind para suportar backups manuais
-- e snapshots de pré-restauração sem quebrar linhagem de publicação.
-- 2. followup_flow_shares guarda snapshots imutáveis para compartilhamento
-- seguro por token público não-enumerável.

alter table public.followup_flow_versions
  add column if not exists label text,
  add column if not exists kind text not null default 'publish';

alter table public.followup_flow_versions
  drop constraint if exists followup_flow_versions_kind_check;

alter table public.followup_flow_versions
  add constraint followup_flow_versions_kind_check
  check (kind in ('publish', 'manual_backup', 'pre_restore'));

create index if not exists idx_followup_versions_pointer_created
  on public.followup_flow_versions (pointer_id, created_at desc);

create table if not exists public.followup_flow_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pointer_id uuid not null references public.followup_flow_pointers(id) on delete cascade,
  token text not null unique,
  status text not null default 'active',
  snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint followup_flow_shares_status_check check (status in ('active', 'revoked'))
);

alter table public.followup_flow_shares enable row level security;

drop policy if exists tenant_isolation_followup_flow_shares_all on public.followup_flow_shares;
create policy tenant_isolation_followup_flow_shares_all on public.followup_flow_shares
  for all using (
    organization_id in (select fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

create index if not exists idx_followup_flow_shares_token
  on public.followup_flow_shares (token) where status = 'active';

create index if not exists idx_followup_flow_shares_pointer
  on public.followup_flow_shares (pointer_id);

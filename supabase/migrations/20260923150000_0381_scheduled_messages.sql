-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0381: Mensagens Programadas (scheduled_messages)
-- Permite agendamento de mensagens (texto, imagem, vídeo, áudio) na Inbox.
-- Fila durável com lease/claim atômico via SKIP LOCKED e recuperação de lease.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  scheduled_for timestamptz not null,
  body text,
  media_storage_path text,
  media_type text check (media_type is null or media_type in ('image', 'video', 'audio')),
  media_mime text,
  media_filename text,
  caption text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  claimed_until timestamptz,
  last_error text,
  sent_message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_scheduled_messages_content check (body is not null or media_storage_path is not null)
);

-- Índices de busca e processamento
create index if not exists idx_scheduled_messages_due
  on public.scheduled_messages (scheduled_for)
  where status in ('pending', 'processing');

create index if not exists idx_scheduled_messages_conversation
  on public.scheduled_messages (organization_id, conversation_id, status);

create index if not exists idx_scheduled_messages_org
  on public.scheduled_messages (organization_id);

-- RLS
alter table public.scheduled_messages enable row level security;

do $$ begin
  create policy tenant_isolation_scheduled_messages_all on public.scheduled_messages
    for all using (
      organization_id in (select fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    )
    with check (
      organization_id in (select fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
    );
exception when duplicate_object then null; end $$;

-- Privilégios
grant select, insert, update, delete on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;
revoke all on public.scheduled_messages from anon;

-- Trigger updated_at
drop trigger if exists trg_scheduled_messages_updated_at on public.scheduled_messages;
create trigger trg_scheduled_messages_updated_at
  before update on public.scheduled_messages
  for each row execute function public.fn_set_updated_at();

-- Claim atômico e concorrente com lease recovery (SKIP LOCKED) — service role only
create or replace function public.fn_claim_due_scheduled_messages(p_limit int, p_lease_seconds int)
returns setof public.scheduled_messages
language sql
security definer
set search_path = public
as $$
  update public.scheduled_messages sm
  set status = 'processing',
      claimed_until = now() + make_interval(secs => p_lease_seconds),
      attempts = sm.attempts + 1,
      updated_at = now()
  where sm.id in (
    select id from public.scheduled_messages
    where (
      (status = 'pending' and scheduled_for <= now() and (claimed_until is null or claimed_until < now()))
      or
      (status = 'processing' and claimed_until < now())
    )
    order by scheduled_for
    limit p_limit
    for update skip locked
  )
  returning sm.*;
$$;

revoke all on function public.fn_claim_due_scheduled_messages(int, int) from public, anon, authenticated;
grant execute on function public.fn_claim_due_scheduled_messages(int, int) to service_role;

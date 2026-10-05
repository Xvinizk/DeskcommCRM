-- 0388 — Follow-up flows: suporte a arquivamento e exclusão permanente transacional.
--
-- 1. Coluna `archived_at` em `followup_flow_pointers`:
--    - fluxos arquivados não aceitam novos enrollments
--    - execuções ativas já iniciadas continuam até o fim
--    - restauração preserva o status anterior
-- 2. Evolução de `fn_delete_followup_flow`:
--    - suporta `p_purge_history boolean default false`
--    - bloqueia status vivos canônicos: 'active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual'
--    - bloqueia se referenciado pela versão publicada de um agente ativo (ai_agents.published_version_id)
--    - bloqueia se houver jobs em execução no job_queue
--    - invalida jobs pendentes antes do purge
--    - desassocia appointment_recovery_receipts sem erro 42501
--    - limpa drafts de agentes
--    - remove enrollments, versions, shares e pointer atomicamente
-- 3. Função de contadores `fn_followup_flow_deletion_summary`:
--    - contadores de versões, histórico, ativos, agentes e jobs para o modal

alter table public.followup_flow_pointers
  add column if not exists archived_at timestamptz;

create index if not exists idx_followup_flow_pointers_archived
  on public.followup_flow_pointers (organization_id, archived_at);

create or replace function public.fn_followup_flow_deletion_summary(
  p_org uuid,
  p_pointer uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_versions int := 0;
  v_active int := 0;
  v_completed int := 0;
  v_cancelled int := 0;
  v_other int := 0;
  v_events int := 0;
  v_agents int := 0;
  v_running_jobs int := 0;
  v_pending_jobs int := 0;
begin
  select name into v_name
  from public.followup_flow_pointers
  where id = p_pointer and organization_id = p_org;

  if not found then
    return null;
  end if;

  select count(*) into v_versions
  from public.followup_flow_versions
  where organization_id = p_org and pointer_id = p_pointer;

  select
    count(*) filter (where status in ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual')),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'cancelled'),
    count(*) filter (where status not in ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual', 'completed', 'cancelled'))
  into v_active, v_completed, v_cancelled, v_other
  from public.followup_enrollments
  where organization_id = p_org and pointer_id = p_pointer;

  select count(*) into v_events
  from public.followup_enrollment_events fee
  join public.followup_enrollments fe on fe.id = fee.enrollment_id
  where fe.organization_id = p_org and fe.pointer_id = p_pointer;

  select count(*) into v_agents
  from public.ai_agents a
  join public.ai_agent_versions v on v.id = a.published_version_id
  where a.organization_id = p_org
    and a.archived_at is null
    and (
      v.followup->'flow_pointer_ids' @> to_jsonb(p_pointer::text)
      or v.followup->>'flow_pointer_id' = p_pointer::text
    );

  select
    count(*) filter (where status = 'running' or (locked_at is not null and locked_at > now() - interval '5 minutes')),
    count(*) filter (where status = 'pending')
  into v_running_jobs, v_pending_jobs
  from public.job_queue
  where organization_id = p_org
    and (
      payload->>'pointer_id' = p_pointer::text
      or payload->>'enrollment_id' in (
        select id::text from public.followup_enrollments where pointer_id = p_pointer and organization_id = p_org
      )
    );

  return jsonb_build_object(
    'flow_name', v_name,
    'versions_count', v_versions,
    'active_enrollments', v_active,
    'completed_enrollments', v_completed,
    'cancelled_enrollments', v_cancelled,
    'other_historical_enrollments', v_other,
    'total_events_count', v_events,
    'agent_references', v_agents,
    'running_jobs', v_running_jobs,
    'pending_jobs', v_pending_jobs,
    'can_delete', (v_active = 0 and v_agents = 0 and v_running_jobs = 0)
  );
end;
$$;

revoke execute on function public.fn_followup_flow_deletion_summary(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_followup_flow_deletion_summary(uuid, uuid) to service_role;

-- Drop function signature antiga de 2 parâmetros se existir para evitar ambiguidade
drop function if exists public.fn_delete_followup_flow(uuid, uuid);

create or replace function public.fn_delete_followup_flow(
  p_org uuid,
  p_pointer uuid,
  p_purge_history boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_count int;
  v_running_jobs int;
begin
  -- 1. Verificar se o ponteiro existe e pertence à organização
  if not exists (
    select 1
    from public.followup_flow_pointers
    where id = p_pointer and organization_id = p_org
  ) then
    raise exception 'pointer_not_found' using errcode = 'P0002';
  end if;

  -- 2. Verificar se há enrollments vivos (bloqueia em QUALQUER modalidade de delete)
  select count(*) into v_active_count
  from public.followup_enrollments
  where organization_id = p_org
    and pointer_id = p_pointer
    and status in ('active', 'waiting_reply', 'dormente', 'paused_handoff', 'paused_manual');

  if v_active_count > 0 then
    raise exception 'flow_has_active_enrollments' using errcode = 'P0001';
  end if;

  -- 3. Verificar se está em uso por versão publicada de agente ativo
  if exists (
    select 1
    from public.ai_agents a
    join public.ai_agent_versions v on v.id = a.published_version_id
    where a.organization_id = p_org
      and a.archived_at is null
      and (
        v.followup->'flow_pointer_ids' @> to_jsonb(p_pointer::text)
        or v.followup->>'flow_pointer_id' = p_pointer::text
      )
  ) then
    raise exception 'flow_in_use_by_agent' using errcode = 'P0003';
  end if;

  -- 4. Se não for purge_history, bloquear caso haja histórico concluído/cancelado/dead
  if not p_purge_history then
    if exists (
      select 1
      from public.followup_enrollments
      where organization_id = p_org and pointer_id = p_pointer
    ) then
      raise exception 'flow_has_history' using errcode = 'P0004';
    end if;
  else
    -- 4b. Em purge_history, verificar se há tarefas em execução no momento
    select count(*) into v_running_jobs
    from public.job_queue
    where organization_id = p_org
      and (status = 'running' or (locked_at is not null and locked_at > now() - interval '5 minutes'))
      and (
        payload->>'pointer_id' = p_pointer::text
        or payload->>'enrollment_id' in (
          select id::text from public.followup_enrollments where pointer_id = p_pointer and organization_id = p_org
        )
      );

    if v_running_jobs > 0 then
      raise exception 'flow_jobs_in_progress' using errcode = 'P0005';
    end if;

    -- Invalidar jobs pendentes vinculados a este fluxo antes do purge
    update public.job_queue
    set status = 'dead',
        last_error = 'flow_permanently_deleted'
    where organization_id = p_org
      and status = 'pending'
      and (
        payload->>'pointer_id' = p_pointer::text
        or payload->>'enrollment_id' in (
          select id::text from public.followup_enrollments where pointer_id = p_pointer and organization_id = p_org
        )
      );
  end if;

  -- 5. Limpar referências em versões rascunho de agentes (se houver)
  update public.ai_agent_versions
  set followup = jsonb_set(
    followup,
    '{flow_pointer_ids}',
    (
      select coalesce(jsonb_agg(elem), '[]'::jsonb)
      from jsonb_array_elements_text(followup->'flow_pointer_ids') as elem
      where elem <> p_pointer::text
    )
  )
  where organization_id = p_org
    and status = 'draft'
    and (
      followup->'flow_pointer_ids' @> to_jsonb(p_pointer::text)
      or followup->>'flow_pointer_id' = p_pointer::text
    );

  -- 6. Desassociar appointment_recovery_receipts (evita falha de permissão no trigger/FK)
  update public.appointment_recovery_receipts
  set pointer_id = null,
      enrollment_id = null
  where organization_id = p_org
    and (
      pointer_id = p_pointer
      or enrollment_id in (
        select id from public.followup_enrollments where pointer_id = p_pointer and organization_id = p_org
      )
    );

  -- 7. Desfazer ciclo quebrando a FK active_version_id
  update public.followup_flow_pointers
  set active_version_id = null
  where id = p_pointer and organization_id = p_org;

  -- 8. Remover enrollments do pointer (se purge_history for true)
  delete from public.followup_enrollments
  where pointer_id = p_pointer and organization_id = p_org;

  -- 9. Remover versões vinculadas ao pointer
  delete from public.followup_flow_versions
  where pointer_id = p_pointer and organization_id = p_org;

  -- 10. Remover compartilhamentos vinculados ao pointer
  delete from public.followup_flow_shares
  where pointer_id = p_pointer;

  -- 11. Remover o pointer definitivamente
  delete from public.followup_flow_pointers
  where id = p_pointer and organization_id = p_org;

  return true;
end;
$$;

revoke execute on function public.fn_delete_followup_flow(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_delete_followup_flow(uuid, uuid, boolean) to service_role;

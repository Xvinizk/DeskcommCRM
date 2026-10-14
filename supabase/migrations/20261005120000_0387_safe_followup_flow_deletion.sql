-- 0387 — Exclusão segura e atômica de fluxos de follow-up
--
-- fn_delete_followup_flow(p_org uuid, p_pointer uuid)
-- 1. Garante isolamento por organização e lock FOR UPDATE no pointer.
-- 2. Recusa com 'flow_has_active_enrollments' se houver contatos em execução.
-- 3. Recusa com 'flow_has_history' se houver execuções passadas (preserva histórico/auditoria).
-- 4. Recusa com 'flow_in_use_by_agent' se houver agente publicado armado com o fluxo.
-- 5. Limpa referências em rascunhos de agentes (status='draft') da organização para não deixar órfãos.
-- 6. Remove compartilhamentos em followup_flow_shares.
-- 7. Quebra active_version_id para evitar ciclo de FK com versions.
-- 8. Apaga versions e pointer atomicamente sob SECURITY DEFINER.

create or replace function public.fn_delete_followup_flow(
  p_org uuid,
  p_pointer uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointer record;
  v_has_active_enrollments boolean;
  v_has_history boolean;
  v_in_use_by_published_agent boolean;
begin
  select id, organization_id, active_version_id
    into v_pointer
  from public.followup_flow_pointers
  where id = p_pointer and organization_id = p_org
  for update;

  if not found then
    raise exception 'pointer_not_found' using errcode = 'P0001';
  end if;

  -- 1. Verifica contatos em execução
  select exists (
    select 1 from public.followup_enrollments
    where pointer_id = p_pointer
      and organization_id = p_org
      and status in ('active', 'waiting_reply', 'paused_handoff')
  ) into v_has_active_enrollments;

  if v_has_active_enrollments then
    raise exception 'flow_has_active_enrollments' using errcode = 'P0002';
  end if;

  -- 2. Verifica histórico de execuções finalizadas
  select exists (
    select 1 from public.followup_enrollments
    where pointer_id = p_pointer
      and organization_id = p_org
      and status in ('completed', 'cancelled', 'dead')
  ) into v_has_history;

  if v_has_history then
    raise exception 'flow_has_history' using errcode = 'P0003';
  end if;

  -- 3. Verifica se algum agente publicado usa este fluxo
  select exists (
    select 1 from public.ai_agent_versions
    where organization_id = p_org
      and status = 'published'
      and (followup->'enabled')::boolean = true
      and followup->'flow_pointer_ids' ? p_pointer::text
  ) into v_in_use_by_published_agent;

  if v_in_use_by_published_agent then
    raise exception 'flow_in_use_by_agent' using errcode = 'P0004';
  end if;

  -- 4. Limpa referências em rascunhos de agentes da organização (status='draft' é mutável)
  update public.ai_agent_versions
  set followup = jsonb_set(
    followup,
    '{flow_pointer_ids}',
    coalesce(
      (
        select jsonb_agg(elem)
        from jsonb_array_elements(followup->'flow_pointer_ids') elem
        where elem #>> '{}' <> p_pointer::text
      ),
      '[]'::jsonb
    )
  )
  where organization_id = p_org
    and status = 'draft'
    and followup->'flow_pointer_ids' ? p_pointer::text;

  -- 5. Exclui compartilhamentos do pointer
  delete from public.followup_flow_shares
  where pointer_id = p_pointer and organization_id = p_org;

  -- 6. Quebra active_version_id para evitar ciclo de FK
  update public.followup_flow_pointers
  set active_version_id = null
  where id = p_pointer and organization_id = p_org;

  -- 7. Exclui versões do fluxo
  delete from public.followup_flow_versions
  where pointer_id = p_pointer and organization_id = p_org;

  -- 8. Exclui o pointer
  delete from public.followup_flow_pointers
  where id = p_pointer and organization_id = p_org;

  return true;
end;
$$;

revoke all on function public.fn_delete_followup_flow(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_followup_flow(uuid, uuid) to service_role;

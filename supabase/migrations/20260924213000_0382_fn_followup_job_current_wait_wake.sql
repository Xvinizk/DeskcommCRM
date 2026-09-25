-- Corrige fn_followup_job_current para validar jobs de wait_wake originados de wait_started.
-- Preserva todas as validações de isolamento multi-tenant, service boundary, appointment e integridade de geração.
create or replace function public.fn_followup_job_current(p_org uuid,p_job uuid,p_enrollment uuid,p_node text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.job_queue j
  join public.followup_enrollments e on e.id=p_enrollment and e.organization_id=j.organization_id and e.contact_id=j.contact_id
  join public.followup_enrollment_events origin on origin.organization_id=e.organization_id and origin.enrollment_id=e.id
   and origin.node_id=p_node
   and (
     (
       j.payload->>'purpose' = 'wait_wake'
       and origin.event_type = 'wait_started'
       and (
         origin.idempotency_key = j.payload->>'source_step_key'
         or origin.idempotency_key = regexp_replace(j.payload->>'source_step_key', ':wake$', '')
       )
     )
     or
     (
       coalesce(j.payload->>'purpose', '') <> 'wait_wake'
       and origin.event_type in ('turn_enqueued','classify_enqueued')
       and origin.idempotency_key = j.payload->>'source_step_key'
     )
   )
  where j.id=p_job and j.organization_id=p_org and j.kind='followup_turn' and j.status in ('pending','running')
   and j.payload->>'followup_enrollment_id'=p_enrollment::text and j.payload->>'node_id'=p_node
   and origin.idempotency_key = origin.node_id||':'||substring(origin.idempotency_key from ':([0-9]+)$')
   and public.fn_appointment_enrollment_current(p_org,p_enrollment,p_node)
   and not exists(select 1 from public.followup_enrollment_events later
    where later.organization_id=p_org and later.enrollment_id=e.id
     and later.idempotency_key=later.node_id||':'||substring(later.idempotency_key from ':([0-9]+)$')
     and substring(later.idempotency_key from ':([0-9]+)$')::numeric > substring(origin.idempotency_key from ':([0-9]+)$')::numeric
     and not (later.node_id=p_node and later.event_type='action_recheck')));
$$;

revoke all on function public.fn_followup_job_current(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_followup_job_current(uuid,uuid,uuid,text) to service_role;

-- 0386_followup_patch_ai_node_session
-- Follow-up Flow: persistência de ai_node_session em fn_followup_patch.
--
-- A migration 0385 adicionou a coluna ai_node_session em followup_enrollments,
-- mas o UPDATE em fn_followup_patch não incluía ai_node_session = patched.ai_node_session.
-- Esta migration recompõe fn_followup_patch mantendo estritamente a assinatura,
-- locks, checagens de appointment/revisão, e adiciona a persistência de ai_node_session.
--
-- Idempotente: create or replace function.

create or replace function public.fn_followup_patch(p_org uuid, p_id uuid, p_revision bigint, p_patch jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare current public.followup_enrollments; patched public.followup_enrollments; contact uuid;
begin
 select contact_id into contact from public.followup_enrollments where id=p_id and organization_id=p_org;
 if not found then raise exception 'followup_stale' using errcode='P0001'; end if;
 perform public.fn_service_lock(p_org,contact);
 select * into current from public.followup_enrollments where id=p_id and organization_id=p_org for update;
 if current.contact_id is distinct from contact or current.revision is distinct from p_revision then raise exception 'followup_stale' using errcode='P0001'; end if;
 if p_patch->>'status' in ('active','waiting_reply') and current.appointment_revision is not null and not public.fn_appointment_enrollment_current(p_org,p_id,current.current_node_id) then raise exception 'followup_stale' using errcode='P0001'; end if;
 select * into patched from jsonb_populate_record(current,p_patch);
 update public.followup_enrollments set status=patched.status,current_node_id=patched.current_node_id,next_eval_at=patched.next_eval_at,
  claimed_until=patched.claimed_until,attempts=patched.attempts,last_error=patched.last_error,steps_taken=patched.steps_taken,
  outcome=patched.outcome,cancel_reason=patched.cancel_reason,completed_at=patched.completed_at,timing_plan=patched.timing_plan,
  ai_node_session=patched.ai_node_session
 where organization_id=p_org and id=p_id returning revision into p_revision;
 return p_revision;
end; $$;

revoke all on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) to service_role;

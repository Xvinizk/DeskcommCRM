-- 0385_ai_node_enrollment_session
-- Follow-up Flow Builder v2: suporte a estado de sessão do Node IA no enrollment.
--
-- Adiciona a coluna `ai_node_session` (jsonb nullable) na tabela `public.followup_enrollments`.
-- Guarda o estado transiente do nó de IA (turn_count, started_at, last_inbound_at, agent_id, etc.)
-- como fonte da verdade canônica do nó no enrollment.
--
-- Aditiva e retrocompatível:
-- - Coluna nasce NULL;
-- - Não altera linhas existentes;
-- - Compatível com rollback: binários antigos ignoram a coluna.
--
-- Idempotente: alter table add column if not exists.

alter table public.followup_enrollments
  add column if not exists ai_node_session jsonb;

comment on column public.followup_enrollments.ai_node_session is
  'Estado transiente de execução do nó IA (turn_count, last_inbound_at, agent_id, etc.). Fonte da verdade canônica do nó no enrollment.';

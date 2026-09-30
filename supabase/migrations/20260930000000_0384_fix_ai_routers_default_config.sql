-- 0384: Ajusta o default de ai_routers.config para remover 'claude-haiku-4-5' hardcoded.
-- Novos roteadores nascem com classifier_model nulo (modo AUTO), respeitando o provedor e modelo
-- configurados em ai_purpose_bindings (painel Provedores) ou organizations.settings.llm.
-- Corrige também roteadores legados que tenham 'claude-haiku-4-5' sem classifier_provider.

alter table public.ai_routers
  alter column config set default jsonb_build_object(
    'sticky', true,
    'min_confidence', 0.6
  );

update public.ai_routers
   set config = (config - 'classifier_model')
 where config->>'classifier_model' = 'claude-haiku-4-5'
   and (config->>'classifier_provider' is null or config->>'classifier_provider' = '');

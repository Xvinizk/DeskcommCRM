-- REVERTER a migration 0389 (painel da operação) — SÓ em emergência.
--
-- ⚠️ APAGA DADO: as vendas registradas (`operation_sales`) e os gastos lançados
-- (`ad_spend_daily`) somem junto com as tabelas. Antes de rodar, exporte-as:
--   copy public.operation_sales to stdout with csv header;
--   copy public.ad_spend_daily  to stdout with csv header;
--
-- Nada além do que a 0389 criou é tocado: `crm_leads`, `sales`, `contacts` e
-- `payment_methods` só perdem o gatilho e as chaves estrangeiras que APONTAVAM
-- para elas a partir das tabelas novas.
--
-- Ordem: o gatilho sai primeiro (senão o próximo arrasto de lead tentaria gravar
-- numa tabela que não existe e o arrasto falharia), depois as funções, depois as
-- tabelas. Tudo numa transação: ou volta inteiro, ou nada muda.
begin;

drop trigger if exists trg_venda_do_lead_ganho on public.crm_leads;
drop function if exists public.fn_sincronizar_venda_do_lead();
drop function if exists public.fn_painel_operacao(uuid, date, date);
drop table if exists public.operation_sales;
drop table if exists public.ad_spend_daily;

commit;

-- Depois de reverter no banco, volte também a imagem do app para uma versão
-- sem o painel (a tela /app/operacao passaria a responder erro).

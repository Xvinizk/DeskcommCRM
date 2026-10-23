# Painel da operação — plano de implementação

> **Para quem executa:** superpowers:executing-plans. Passos em checkbox.

**Objetivo:** registrar vendas (no contato, em lote rápido sem contato, ou sozinhas quando o lead vai para "Ganho") e o gasto diário no Meta, e mostrar faturamento, nº de vendas, ticket médio, gasto, ROAS e custo por venda, por dia e por período.

**Arquitetura:** tabela nova `operation_sales` (venda registrada) e `ad_spend_daily` (gasto por dia). Um gatilho em `crm_leads` mantém a venda automática do lead ganho (upsert idempotente, uma por lead; sair de Ganho estorna). `fn_painel_operacao` agrega NO BANCO, juntando vendas registradas e comandas finalizadas não estornadas, com dias no fuso da organização. Rotas `/api/v1/operacao/*` e `/api/v1/reports/operacao`; tela `/app/operacao`.

**Stack:** Next.js 16 App Router, Supabase (RLS), Zod, TanStack Query, recharts, Vitest.

**Spec:** pedido do dono (conversa de 22/10/2026), respondido nas 3 perguntas — as duas formas de lançar venda com campos opcionais; gasto só do Meta; lead em Ganho com valor vira venda sem duplicar.

## Restrições globais

- `organization_id uuid not null ... on delete cascade` + RLS `tenant_isolation_<t>_all` (leitura membro, escrita `agent`; gasto escrita `manager`).
- Dinheiro em `_cents bigint` + `currency` ISO-4217 (padrão `BRL`).
- Migration `20261022120000_0389_painel_da_operacao.sql` + bloco idempotente no fim do `baseline.sql` + linha no `MANIFEST.md`.
- Função nova em `public`: `revoke execute ... from public, anon` + grant explícito.
- Audit sem texto livre (descrição da venda NÃO vai para `metadata`).
- Toda string de tela via `t()` com entrada `es` em `lib/i18n/dicionario.ts`.
- Venda nunca é apagada: `status` `active` → `reversed`.

## Decisões minhas (não vieram do dono)

1. Venda registrada é tabela própria, não comanda: a comanda exige forma de pagamento e conta (`sales_finalizada_tem_forma`), e o dono quer esses campos opcionais. O painel soma as duas fontes e mostra a origem; comanda nunca gera `operation_sales`, então não há dupla contagem.
2. Lançamento rápido "3 vendas, R$ 300" = UMA linha com `quantity = 3`, `amount_cents = 30000`. Ticket médio = soma dos valores ÷ soma das quantidades.
3. Venda do lead ganho: só quando `value_cents > 0`. Data = `closed_at` no fuso da org. Valor editado com o lead ainda em Ganho atualiza a venda. Voltar a ganhar reativa a MESMA linha.
4. Gasto: um valor manual por dia (`unique (org, dia, plataforma, origem)`); se um dia futuro tiver gasto sincronizado do Meta, ele vence o manual daquele dia.
5. ROAS = faturamento ÷ gasto, `null` quando gasto = 0. Custo por venda = gasto ÷ vendas, `null` quando vendas = 0.
6. Período máximo de 366 dias por consulta.
7. Botão na conversa fica para depois; v1 tem o botão na tela do painel e na ficha do contato.

## Foco de revisão

- Lead sai de Ganho e volta: uma linha, reativada, com o valor novo — nunca duas.
- Lead ganho sem valor (ou valor zerado depois): nenhuma venda / venda estornada.
- Dia sem venda nem gasto aparece zerado na série (sem buraco no gráfico).
- Venda às 23h30 em São Paulo cai no dia certo (não no dia seguinte em UTC).
- Estornar venda automática pela tela é recusado (o caminho é tirar o lead de Ganho).

---

### Tarefa 1: Schema (tabelas, gatilho, função do painel)

**Arquivos:** criar `supabase/migrations/20261022120000_0389_painel_da_operacao.sql`; apêndice no `supabase/baseline.sql`; linha em `supabase/migrations/MANIFEST.md`; tipos em `lib/database.types.ts`. Teste: `tests/unit/painel-da-operacao-no-schema.test.ts` (lê o baseline sem comentários, como `comanda-invariantes-no-schema.test.ts`) e `tests/invariants/painel-da-operacao.test.ts` (Postgres real).

**Produz:**
- `operation_sales(id, organization_id, sold_on date, quantity int>0, amount_cents bigint>0, currency, description text<=300 null, contact_id null, lead_id null, payment_method_id null, origin 'manual'|'lead_won', status 'active'|'reversed', reversed_at, created_by_user_id, created_at, updated_at)`; índice único parcial `(organization_id, lead_id) where lead_id is not null`.
- `ad_spend_daily(id, organization_id, spend_date, platform 'meta', amount_cents>=0, currency, source 'manual'|'meta_sync', created_by_user_id, created_at, updated_at)`; único `(organization_id, spend_date, platform, source)`.
- `fn_sincronizar_venda_do_lead()` (trigger, security definer) + `trg_venda_do_lead_ganho` after insert or update of status, value_cents, currency, closed_at, contact_id.
- `fn_painel_operacao(p_org uuid, p_de date, p_ate date) returns jsonb` com `faturamento_cents, vendas, ticket_medio_cents, gasto_cents, roas, custo_por_venda_cents, por_origem{registradas,funil,comandas → {vendas, faturamento_cents}}, por_dia[{dia, vendas, faturamento_cents, gasto_cents}]`.

- [ ] teste de schema falhando (tabelas, CHECKs, índice parcial, RLS, revoke, gatilho) → rodar → FAIL
- [ ] invariantes escritos: ganhar→1 venda; ganhar de novo→ainda 1; sair de Ganho→reversed; voltar→reativada com valor novo; sem valor→nada; isolamento entre 2 orgs; painel com dia em fuso SP e série sem buraco
- [ ] migration + apêndice + MANIFEST + tipos → teste de schema PASS
- [ ] commit

### Tarefa 2: Contratos e período (puro)

**Arquivos:** `lib/operacao/contratos.ts` (+ `.test.ts`).

**Produz:** `vendaSchema` (zod: `amount_cents` int 1..1e9, `quantity` int 1..1000 default 1, `sold_on` YYYY-MM-DD, `description` ≤300 opcional, `contact_id`/`payment_method_id` uuid opcional), `gastoSchema` (`spend_date`, `amount_cents` int 0..1e9), `periodoValido(de, ate): {ok:true,de,ate} | {ok:false, motivo}` (de≤ate, ≤366 dias), `formatarRoas(roas: number|null): string` ("—" ou "3,25x").

- [ ] testes falhando → FAIL → implementar → PASS → commit

### Tarefa 3: Rotas

**Arquivos:** `app/api/v1/reports/operacao/route.ts` (GET, viewer, rpc), `app/api/v1/operacao/vendas/route.ts` (GET viewer; POST agent, `origin='manual'` fixo, Idempotency-Key via `lib/api/idempotency.ts`, audit `operacao.venda_registrada` só com valores numéricos), `app/api/v1/operacao/vendas/[id]/route.ts` (DELETE agent → `reversed`; 409 `venda_do_funil` se `origin='lead_won'`; audit `operacao.venda_estornada`), `app/api/v1/operacao/gastos/route.ts` (GET viewer; PUT manager upsert; audit `operacao.gasto_lancado`). Teste: `tests/unit/operacao-rotas.test.ts`.

- [ ] testes (403 sem papel, 422 corpo inválido, origin não vem do corpo, descrição fora do audit, 409 no estorno do funil) → FAIL → implementar → PASS → commit

### Tarefa 4: Tela

**Arquivos:** `app/app/operacao/page.tsx`, `app/app/operacao/_client.tsx`, `components/operacao/RegistrarVendaDialog.tsx`, `components/operacao/LancarGastoDialog.tsx`; botão na ficha `app/app/contacts/[id]/_client.tsx`; entrada no `lib/navigation/catalogo.ts` (analise › Dinheiro, viewer, sidebar); textos em `lib/i18n/dicionario.ts`.

- [ ] cards (Faturamento, Vendas, Ticket médio, Gasto em anúncio, ROAS, Custo por venda), filtro (Hoje, 7 dias, 30 dias, Este mês, personalizado), gráfico de barras por dia, tabela por dia, lista das vendas do período com origem e "Estornar"
- [ ] diálogo de venda: valor e quantidade obrigatórios; "Adicionar detalhes" abre data, contato, descrição e forma de pagamento
- [ ] `pnpm typecheck`, testes de navegação e i18n verdes → commit

### Tarefa 5: Fechamento

- [ ] fragmento `.changes/painel-da-operacao.md` (`capacidade_nova`)
- [ ] `pnpm typecheck`, lint dos arquivos novos, `pnpm test:unit` comparado com a linha de base
- [ ] relatório (o que não foi medido: `test:db` sem Docker nesta máquina; prova pela tela)

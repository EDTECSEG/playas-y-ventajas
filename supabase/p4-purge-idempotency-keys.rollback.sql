-- ============================================================================
-- p4-purge-idempotency-keys.rollback.sql
--
-- Desfaz p4-purge-idempotency-keys.sql: remove o agendamento, derruba a funcao
-- de expurgo e apaga o indice de created_at.
--
-- ATENCAO: este arquivo NAO restaura as linhas vencidas. O primeiro run do
-- cron limpa idempotency_keys e isso e irreversivel. Rodar o rollback depois
-- do primeiro run devolve a tabela ao estado do dia, nao ao estado anterior.
--
-- Consequencia de voltar atras: sem o expurgo, coupon.validate volta a reter
-- nome e telefone dos clientes indefinidamente, e coupon.claim volta a reter
-- o rawToken de cada cupom. Se o motivo do rollback for a questao de custo, o
-- problema real e o plano de dados, nao a limpeza.
-- ============================================================================

-- 1) Derruba o agendamento (se existir).
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'purge-idempotency-keys') then
    perform cron.unschedule('purge-idempotency-keys');
  end if;
end
$do$;

-- 2) Derruba a funcao.
drop function if exists public.purge_expired_idempotency_keys();

-- 3) Derruba o indice do expurgo.
drop index if exists public.idempotency_keys_created_at_idx;
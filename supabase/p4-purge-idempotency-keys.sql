-- ============================================================================
-- p4-purge-idempotency-keys.sql
--
-- Expurgo automatico de idempotency_keys, com retencao de 7 dias.
--
-- ---------------------------------------------------------------------------
-- POR QUE ISTO PRECISA EXISTIR
-- ---------------------------------------------------------------------------
-- idempotency_keys guarda o RESULTADO de cada operacao idempotente para que um
-- retry devolva a mesma resposta. O problema e o que vive em `result`:
--
--   operation='coupon.validate' -> businessName, couponId, customerName,
--                                  customerPhone, issuedAt, validatedAt...
--                                  Sem segredo, mas e DADO PESSOAL (nome e
--                                  telefone) e fica retido indefinidamente.
--   operation='coupon.claim'    -> rawToken e shortCode do cupom.
--                                  Sao SEGREDOS: o rawToken e o que o QR
--                                  carrega e o que da direito ao desconto.
--
-- Antes desta migration nao havia ttl nem job: as linhas ficavam para sempre.
-- Com a p3, cada resgate com chave passou a gravar mais uma linha, cada uma
-- carregando o rawToken de um cupom real.
--
-- ESTO E CONTROLE DE RETENCAO DE DADO, NAO DE PERFORMANCE. A tabela tinha
-- 80 kB / 73 linhas na medicao de 2026-10-03. O motivo de limpar e o
-- segredo/PII acumulado, nao o tamanho.
--
-- ---------------------------------------------------------------------------
-- A JANELA DE 7 DIAS
-- ---------------------------------------------------------------------------
-- O que a janela precisa cobrir e o cliente que NAO recebeu o cupom e volta
-- depois ("perdi, deixa eu tentar de novo"). 7 dias cobre esse caso com
-- folga.
--
-- Passada a janela o cache some e o retry volta a se comportar como antes da
-- p3 -- ou seja, pode emitir um cupom novo, limitado por
-- coupon_templates.per_customer_limit. Isso e seguro: o limite continua
-- valendo, o cliente nunca fica sem teto. O que a janela faz e dar tempo ao
-- cliente para recuperar o resgate, nao segurar o cupom para sempre.
--
-- Decisao do dono em 2026-10-03 entre 7 / 30 / 90 dias.
--
-- ---------------------------------------------------------------------------
-- POR QUE pg_cron
-- ---------------------------------------------------------------------------
-- A alternativa era apagar dentro de claim_coupon, que e o CAMINHO CRITICO
-- (dinheiro: estoque, limite, hash) e esta marcado como intocavel no
-- codigo. Colocar um DELETE ali arriscaria a latencia e o resgate por causa
-- de limpeza. Um job diario nao encosta no caminho da request.
--
-- pg_cron roda com o fuso do banco (UTC aqui), entao 04:23 UTC = 01:23 em
-- Brasilia. Minuto 23 de proposito: todo mundo agenda em :00 e :30.
--
-- ---------------------------------------------------------------------------
-- SEGURANCA
-- ---------------------------------------------------------------------------
-- A funcao e SECURITY INVOKER (o default): o job do cron roda como postgres, o
-- dono da tabela. Nao ha necessidade de SECURITY DEFINER, e ele so seria risco.
-- O search_path e fixado mesmo assim. EXECUTE e revogado de PUBLIC/anon/
-- authenticated: a limpeza nao e uma operacao que o cliente possa pedir, e o
-- returnbigint (quantas linhas sairam) tambem nao vaza nada.
--
-- ROLLBACK: supabase/p4-purge-idempotency-keys.rollback.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Indice para o filtro do expurgo
-- ---------------------------------------------------------------------------
-- Sem isto o DELETE varre a tabela inteira (seq scan) a cada dia. A PK
-- (tenant_id, operation, idempotency_key) nao ajuda: o filtro e por
-- created_at. Com o indice o expurgo custa o que as linhas vencidas custam,
-- nao o que a tabela inteira custa.
--
-- IF NOT EXISTS para o arquivo poder ser reaplicado sem efeito colateral.
create index if not exists idempotency_keys_created_at_idx
  on public.idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- 2) Funcao de expurgo
-- ---------------------------------------------------------------------------
-- LANGUAGE sql e uma unica sentenca: o DELETE e a contagem sao atomicos, sem
-- BEGIN/END nem variaveis. Uma DELECAO que falhasse no meio deixaria a tabela
-- inconsistente; aqui nao ha como.
create or replace function public.purge_expired_idempotency_keys()
returns bigint
language sql
volatile
set search_path to 'public', 'extensions'
as $fn$
  -- 7 dias: ver a justificativa no cabecalho. E o unico lugar do sistema onde
  -- esse numero mora; mudar a politica e mexer nesta linha.
  with apagadas as (
delete from idempotency_keys
     where created_at < now() - make_interval(days => 7)
    returning 1
  )
  select count(*) from apagadas;
$fn$;

revoke all on function public.purge_expired_idempotency_keys() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Agendamento diario
-- ---------------------------------------------------------------------------
-- unschedule antes do schedule: se este arquivo for rodado de novo, o
-- agendamento e substituido em vez de duplicado. Sem isto, um segundo
-- schedule com o mesmo jobname deixaria dois jobs diarios apagando a mesma
-- tabela (e o teste de jobname unico do pg_cron nem sempre pega).
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'purge-idempotency-keys') then
    perform cron.unschedule('purge-idempotency-keys');
  end if;
end
$do$;

select cron.schedule(
  'purge-idempotency-keys',
  '23 4 * * *',
  'select public.purge_expired_idempotency_keys()'
);

-- ---------------------------------------------------------------------------
-- 4) Como conferir depois
-- ---------------------------------------------------------------------------
-- Agendamento registrado (esta versao do pg_cron nao tem next_run; a proxima
-- execucao aparece no historico depois do primeiro run):
--   select jobid, jobname, schedule, active, command from cron.job
--    where jobname = 'purge-idempotency-keys';
--
-- Quantas linhas o proximo run vai apagar (NAO apaga, so conta):
--   select count(*) from idempotency_keys
--    where created_at < now() - make_interval(days => 7);
--
-- Historico de execucoes, com quantas linhas cada run removeu:
--   select runid, status, return_message, start_time, end_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'purge-idempotency-keys')
--    order by runid desc limit 10;
-- ============================================================================
-- fix-function-search-path.sql
--
-- Elimina o finding `function_search_path_mutable` do Supabase Advisor
-- (WARN, 42 funcoes) fixando `search_path` em todas as funcoes do app.
--
-- O QUE ISSO FECHA
-- ---------------
-- `search_path` mutavel permite sequestro de resolucao de nome: um atacante
-- que consiga criar um objeto num schema que vem antes de `public` no caminho
-- de busca (o padrao e `"$user", public`) consegue hijackar a resolucao de
-- qualquer chamada nao qualificada dentro da funcao. Em funcao
-- `SECURITY DEFINER` isso e escalada: o corpo roda com os privilegios do dono.
--
-- COMO ISSO FOI VERIFICADO (2026-09-25)
-- ------------------------------------
-- 1. Nenhuma funcao de `public` referencia schema fora de `public`: as 149
--    referencias qualificadas do banco inteiro apontam so para `public`.
--    `auth`, `storage`, `realtime`, `vault`, `graphql*`, `pgbouncer` e
--    `supabase_migrations` aparecem com ZERO referencias.
-- 2. `pgcrypto` (crypt, digest, gen_salt, gen_random_bytes) vive em
--    `extensions`, e `postgis` vive em `public`. Por isso o valor fixado e
--    `public, extensions` — sem `extensions`, qualquer funcao que use pgcrypto
--    sem qualificar passaria a quebrar.
-- 3. `ALTER FUNCTION ... SET` escreve SOMENTE `pg_proc.proconfig`. Nao toca em
--    `prosrc` nem em `prosecdef`, portanto nao pode alterar corpo nem flag
--    `SECURITY DEFINER`. Isso foi conferido com checksum (oid + md5(prosrc) +
--    prosecdef) medido imediatamente antes e depois do lote de ALTER, com o
--    mesmo valor dos dois lados: `d7366dfdbaa587be77f4be9ad7ca29c4`.
-- 4. Advisor de seguranca reconsultado depois: `function_search_path_mutable`
--    saiu da lista (0 findings). Restam apenas os riscos de PostGIS ja
--    aceitos e os 13 INFO de `rls_enabled_no_policy` (11 tabelas antigas +
--    `business_invites` e `driver_registration_tokens`, service_role-only).
-- 5. 47 funcoes distintas foram invocadas dentro de transacoes com ROLLBACK,
--    incluindo as 3 que dependem de postgis (`find_nearby_businesses`,
--    `list_live_vehicles`, `list_shuttle_services`), o caminho de cupom
--    (`claim_coupon`, `validate_and_redeem_coupon`, `issue_coupon_from_template`,
--    `create_coupon_template`, `set_coupon_proximity`), o de auth
--    (`auth_login`, `auth_login_by_email`, `auth_set_pin`, `business_set_pin`,
--    `driver_login`, `driver_logout`) e o de cadastro
--    (`register_business`, `register_business_by_email`, `driver_set_pin`,
--    `driver_add_document`, `admin_driver_reset_pin`,
--    `business_generate_invite`). Zero falhas de resolucao de nome. Estado
--    final: 67/67 funcoes de app com search_path fixo, ACL aberta = 0, e zero
--    residuo de QA.
--
-- ARMADILHA 1 — regprocedure NAO devolve nomes de parametro
-- ---------------------------------------------------------
-- `p.oid::regprocedure::text` devolve apenas os TIPOS: `driver_set_pin(uuid,
-- text, text, text)`. Para escrever a chamada, use SEMPRE
-- `pg_get_function_arguments(p.oid)`. Notacao nomeada com nome errado devolve
-- SQLSTATE 42883 "function ... does not exist" MESMO com todos os tipos
-- corretos — foi o que produziu 8 falsos positivos no primeiro smoke test.
-- Nomes reais que o resumo anterior havia errado:
--   driver_set_pin(p_tenant_id, p_phone, p_pin, p_pin_token)
--   driver_add_document(p_tenant_id, p_driver_id, p_doc_type, p_doc_url,
--                       p_doc_number, p_doc_expires_at, p_session_token uuid,
--                       p_upload_token)
--   claim_coupon(p_tenant_id, p_template_id, p_customer_phone, p_customer_name,
--                p_customer_instagram, p_customer_email)
--   set_coupon_proximity(p_tenant_id, p_actor_user_id, p_template_id, p_lat,
--                        p_lng, p_radius_m)
--   admin_driver_reset_pin(p_tenant_id, p_actor_user_id, p_driver_id, p_new_pin)
--
-- ARMADILHA 2 — DEFEITO PRE-EXISTENTE em create_coupon_template
-- ------------------------------------------------------------
-- Existem dois overloads: o de 8 args e o de 9, e o 9o (`p_image_url`) tem
-- DEFAULT NULL. Quem omitir `p_image_url` recebe SQLSTATE 42725
-- "function ... is not unique". Isto NAO foi introduzido por este arquivo
-- (ALTER ... SET nao afeta resolucao de overload) e NAO e coberto por este
-- script. Workaround para quem chama: passar `p_image_url` explicitamente,
-- mesmo como NULL. Correcao definitiva fica para a slice de cupons.
--
-- POR QUE AS 3 FUNCOES "SO PUBLIC" FICARAM DE FORA
-- -----------------------------------------------
-- `admin_featured_ranks`, `admin_set_featured` e `business_logo_by_id` ja
-- tinham `search_path=public` definido pelos modulos anteriores, entao o
-- filtro deste arquivo as pulou. Verificado que nenhuma delas usa pgcrypto nem
-- postgis, entao `public` sozinho basta para elas. Nao ha necessidade de
-- mexer — e mexer seria escopo alem do necesario.
--
-- REVERSIBILIDADE
-- ---------------
-- Para reverter, basta remover o setting (as funcoes voltam ao padrao):
--   ALTER FUNCTION <assinatura> RESET search_path;
-- Ou, para todas de uma vez, o bloco DO abaixo com `SET` trocado por `RESET`.
-- Nenhuma definicao de funcao e tocada, so `pg_proc.proconfig`.
--
-- ESTE ARQUIVO NAO DROPA NENHUM CREATE: `ALTER FUNCTION ... SET` nao altera
-- ACL, entao a Regra 4 do AGENTS.md nao e acionada aqui. O script e idempotente
-- e pode rodar quantas vezes quiser.
-- ============================================================================


-- 1) Aplica o setting em toda funcao do app que ainda nao tem search_path
do $fix$
declare
  r         record;
  v_aplicadas integer := 0;
  v_puladas   integer := 0;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      -- funcoes membro de extensao nao sao do app (postgis): nao tocar
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
      -- so as que ainda nao tem search_path definido
      and (
        p.proconfig is null
        or not exists (
          select 1 from unnest(p.proconfig) c
          where c like 'search\_path=%'
        )
      )
  loop
    execute format('alter function %s set search_path = public, extensions', r.sig);
    v_aplicadas := v_aplicadas + 1;
  end loop;

  select count(*) into v_puladas
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

  raise notice 'funcoes do app: % | alteradas agora: %', v_puladas, v_aplicadas;
end
$fix$;


-- 2) Verificacao
-- ------------------------------------------------------------------------
-- ainda_sem DEVE ser 0.
-- app_ainda_abertas DEVE continuar 0: `ALTER FUNCTION ... SET` nao mexe no
-- ACL, mas a verificacao esta aqui para fechar a cadeia de evidencia.
-- extensao_ainda_abertas vai continuar != 0 por natureza (postgis nao aceita
-- revogacao) — risco ja aceito e documentado em SECURITY-DECISIONS.md.
SELECT
  count(*) FILTER (WHERE e.extname IS NULL) AS funcs_app,
  count(*) FILTER (WHERE e.extname IS NULL AND NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) c
          WHERE c LIKE 'search\_path=%')) AS ainda_sem,
  count(*) FILTER (WHERE e.extname IS NULL AND EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
          WHERE x.privilege_type = 'EXECUTE'
            AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole))) AS app_ainda_abertas,
  count(*) FILTER (WHERE e.extname IS NOT NULL) AS funcs_extensao,
  count(*) FILTER (WHERE e.extname IS NOT NULL AND EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
          WHERE x.privilege_type = 'EXECUTE'
            AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole))) AS extensao_ainda_abertas
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend  d ON d.objid = p.oid AND d.deptype = 'e'
LEFT JOIN pg_extension e ON e.oid = d.refobjid
WHERE n.nspname = 'public' AND p.prokind = 'f';

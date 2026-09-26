-- ============================================================================
-- close-function-exec.sql
--
-- Fecha EXECUTE de funções do schema public para PUBLIC / anon / authenticated,
-- deixando apenas service_role (e o dono postgres).
--
-- POR QUE ESTE ARQUIVO EXISTE
-- ---------------------------
-- 1) `REVOKE ... ON ALL FUNCTIONS IN SCHEMA public` NAO alcança funções que
--    pertencem a uma extensão (no caso, postgis instalada em public).
-- 2) `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` é
--    gravado com sucesso (aparece em pg_default_acl), mas NAO suprime o
--    EXECUTE implícito de PUBLIC em funções criadas em seguida. Comprovado:
--    `fix-modulo4-reset-pin-scope.sql` faz DROP + CREATE e a função
--    admin_driver_reset_pin nasceu com `=X/postgres` (PUBLIC), abrindo de novo.
--
-- CONSEQUENCIA: rodar este arquivo depois de CADA módulo que crie ou recrie
-- funções. É idempotente, pode rodar quantas vezes quiser.
-- Nenhuma função de public é chamada pelo browser: o app usa só functions
-- server-side com service_role (auditoria confirmou zero `.rpc()` no cliente).
-- ============================================================================

-- 1) Funções do app
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 2) Funções de extensão (postgis): NÃO É POSSÍVEL FECHAR
--    Comprovado empiricamente em 2026-09-25: sobre funções membro de extensão,
--    o PostgreSQL aceita GRANT e REVOKE, não retorna erro, e descarta a
--    alteração (proacl fica idêntico byte a byte). Testado com
--    st_estimatedextent(text,text,text,boolean) nas duas direções.
--    A única correção real é mover a extensão para fora do schema exposto
--    (DROP EXTENSION postgis CASCADE + CREATE EXTENSION postgis SCHEMA
--    extensions), o que cascateia nas colunas/índices de geometria das
--    tabelas do app. Risco alto — não fazer sem janela e backup.
--    Ver a seção "postgis" na verificação no fim deste arquivo.
--
-- 3) Defaults (camada extra; ver aviso no topo)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT  EXECUTE ON FUNCTIONS TO service_role;

-- 4) Verificação
--    app_ainda_abertas DEVE ser 0 — é o que importa, e o script garante.
--    extensao_ainda_abertas vai continuar != 0 por natureza (postgis não aceita
--    revogação); está ali só para deixar o número explícito e não ser
--    re-investigado do zero na próxima vez.
--    Atenção: PUBLIC tem grantee OID 0. Filtrar por '0'::regrole NÃO funciona
--    (retorna NULL e nunca casa) — compare o OID numericamente.
--    Usado EXISTS (e não JOIN) para não multiplicar linhas quando uma função
--    tem mais de uma entrada aberta no ACL.
SELECT
  count(*) FILTER (WHERE e.extname IS NULL) AS funcs_app,
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

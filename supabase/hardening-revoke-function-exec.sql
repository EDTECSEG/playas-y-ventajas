-- ============================================================
-- HARDENING: remover EXECUTE publico nas funcoes do schema public
-- ------------------------------------------------------------
-- RODE APOS todos os modulos. Idempotente.
--
-- ------------------------------------------------------------
-- O VULNERABILIDADE (verificada em 25/09/2026, nao e teoria)
-- ------------------------------------------------------------
-- Toda funcao em public tem EXECUTE liberado para PUBLIC, anon e
-- authenticated. A anon key e uma chave PUBLICA por design: ela estava
-- embutida no bundle de cliente (.netlify/static/.../page-*.js) e qualquer
-- pessoa podia extrai-la do site.
--
-- Como TODO acesso da aplicacao passa pelas edge functions usando
-- service_role (nao existe uma unica chamada .rpc() no codigo do navegador),
-- nenhuma dessas funcoes precisa ser executavel por anon.
--
-- EXPLOITACAO COMPROVADA antes desta correcao:
--   POST /rest/v1/rpc/auth_login_by_email
--   body: { "p_tenant_slug": "playas-y-ventajas", "p_email": "<email da empresa>" }
--   -> HTTP 200 + sessionToken VALIDO
--
-- Sem OTP, sem senha, sem PIN. Porque a conferencia do OTP acontece na
-- edge function (login-by-email.js -> isValidOtp), e NAO dentro da RPC.
-- Chamar a RPC direto pula a verificacao inteira.
--
-- Quem e atingido hoje: os 2 usuarios MERCHANT ativos que tem email
-- preenchido. Quem seria atingido AMANHA: o SUPER_ADMIN, assim que
-- alguem preencher o email dele. Era uma Granada esperando.
--
-- Por que as outras RPCs nao sao exploraveis do mesmo jeito:
--   auth_login (internal_code + PIN)  -> o PIN e conferido DENTRO da RPC
--   claim_coupon                     -> valida limite/estoque DENTRO da RPC
-- As duas sao auto-protegidas por desenho. So as que confiam em
-- "chamar pela edge function significa que o ator foi validado"
-- estavam expostas.
--
-- ------------------------------------------------------------
-- POR QUE ISSO NAO QUEBRA O APP
-- ------------------------------------------------------------
-- 1) Nenhuma politica de RLS chama funcao (todas usam current_setting).
--    Auditadas as 9 politicas: nenhuma depende de EXECUTE.
-- 2) Nao ha trigger no schema public.
-- 3) Nenhum DEFAULT de coluna chama funcao de public: so now() e
--    gen_random_uuid(), que sao do pg_catalog.
-- 4) As views rodam como dono (postgres), que mantem EXECUTE.
-- 5) service_role mantem EXECUTE, e e ele que as edge functions usam.
-- 6) O SQL Editor e o MCP usam postgres (superuser), que ignora ACL.
--
-- Se algo quebrar, o jeito de desfazer esta no fim do arquivo.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Fecha tudo para PUBLIC, anon e authenticated
-- ------------------------------------------------------------
-- ON ALL FUNCTIONS IN SCHEMA pega todas as sobrecargas de uma vez, sem
-- precisar listar assinatura por assinatura.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;


-- ------------------------------------------------------------
-- 2) Garante o que as edge functions realmente usam
-- ------------------------------------------------------------
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;


-- ------------------------------------------------------------
-- 3) Durabilidade: para que as funcoes futuras nao voltem a ser publicas
-- ------------------------------------------------------------
-- Sem isto, cada CREATE FUNCTION futuro (modulo 5, 6, ...) nasce de novo
-- com EXECUTE para PUBLIC, e a falha se repete. DEFAULT PRIVILEGES e o que
-- fecha a porta permanently.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;


-- ------------------------------------------------------------
-- 4) Se precisar abrir UMA funcao especifica para anon
-- ------------------------------------------------------------
-- Ate aqui, nenhuma. Se surgir um caso legitimo (ex: uma view de catalogo
-- lida direto pelo navegador), libere APENAS ela, e nunca uma que aceite
-- p_actor_user_id ou emita sessao:
--
--   GRANT EXECUTE ON FUNCTION public.list_offers(uuid) TO anon, authenticated;


-- ------------------------------------------------------------
-- 5) VERIFICACAO (rode depois de aplicar; esperado: 0 linhas)
-- ------------------------------------------------------------
-- SELECT p.proname, array_to_string(p.proacl, ' ; ') AS acl
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND (p.proacl IS NULL OR p.proacl::text ILIKE '%anon%');
--
-- Se voltar alguma linha, a funcao acima ainda esta aberta para anon.
-- Se voltar MLHOTAS linhas, o passo 1 nao rodou.


-- ============================================================
-- OPCIONAL (fora do escopo deste patch) - rode em separado se quiser
-- ============================================================
-- A tabela sessions tem 398 linhas EXPIRADAS acumuladas (sessao vale 12h
-- e nunca e apagada). Nao e seguranca, e so crescimento de tabela.
-- As sessoes expiradas nao concedem acesso nenhum, entao deletar e seguro,
-- mas como apaga dado, deixei commented:
--
--   DELETE FROM sessions   WHERE expires_at < now();
--   DELETE FROM driver_sessions WHERE expires_at < now();
--
-- ============================================================
-- COMO DESFAZER (se algum fluxo quebrar)
-- ============================================================
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
--
-- E para as funcoes futuras voltarem ao comportamento antigo:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

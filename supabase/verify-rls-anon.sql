-- ============================================================
-- VERIFICACAO: o anon/authenticated nao enxerga dado de negocio
-- ------------------------------------------------------------
-- SOMENTE LEITURA. Nao cria, altera nem apaga nada. Idempotente.
-- Pode rodar em qualquer momento e em qualquer ambiente.
--
-- POR QUE ESTE ARQUIVO EXISTE
-- ------------------------------------------------------------
-- As 25 tabelas do app estao com RLS ligado. 8 delas tem policy
-- PERMISSIVE TO public baseada em current_setting('app.current_tenant_id').
-- Essa variavel de sessao NUNCA e definida em lugar nenhum do codigo.
-- Entao o qual da policy resolve para NULL e o RLS nega tudo.
--
-- Isso e fail-closed ACIDENTAL, nao por desenho. E a unica coisa que
-- segura o acesso hoje.
--
-- Se alguem algum dia rodar set_config('app.current_tenant_id', ...)
-- ou criar uma policy permissiva nova, a barreira cai na hora e nao
-- ha teste que falhe. Este arquivo e esse teste.
--
-- ------------------------------------------------------------
-- O QUE ESTE SCRIPT AFIRMA (e o que ele nao pode provar)
-- ------------------------------------------------------------
-- AFIRMA: com os papeis anon e authenticated, nenhuma tabela de
-- negocio devolve linha. Se algum dia devolver, este script levanta
-- excecao e o build/auditoria quebra.
--
-- NAO AFIRMA: que o backend valida quem pode chamar o que. O backend
-- usa service_role, que tem rolbypassrls = true e therefore ignora
-- RLS por completo. A fronteira real do app e a validacao dentro das
-- Netlify functions, nao o RLS. Ver SECURITY-DECISIONS.md.
--
-- ------------------------------------------------------------
-- COMO RODAR
-- ------------------------------------------------------------
--   supabase db execute --file supabase/verify-rls-anon.sql
--
-- Saida esperada: apenas notices, sem excecao.
-- Se levantar excecao: REVERTER o que mudou. Nao ignore.
-- ============================================================

DO $verify$
DECLARE
  v_tabelas   TEXT[];
  v_papeis    TEXT[] := ARRAY['anon', 'authenticated'];
  v_tabela    TEXT;
  v_papel     TEXT;
  v_n         BIGINT;
  v_rls       BOOLEAN;
  v_falhas    TEXT[] := '{}';
  v_negadas   TEXT[] := '{}';
  v_abertas    TEXT[] := '{}';
  v_aviso     TEXT;
BEGIN
  -- OBRIGATORIO montar a lista ANTES de trocar de papel: depois de
  -- setar anon, a leitura de pg_class/pg_policy nao reflete o catalogo
  -- necessario e a contagem sai errada.
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO v_tabelas
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND pg_get_userbyid(c.relowner) = 'postgres';

  RAISE NOTICE 'verificando % tabelas de negocio x % papeis', array_length(v_tabelas,1), array_length(v_papeis,1);

  FOREACH v_papel IN ARRAY v_papeis LOOP

    FOR v_tabela IN SELECT unnest(v_tabelas) LOOP

      -- painel: a tabela tem RLS ligado?
      EXECUTE format('SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass(%L)', 'public.'||v_tabela)
        INTO v_rls;

      IF NOT v_rls THEN
        v_abertas := v_abertas || (v_tabela || ' [sem RLS]');
      END IF;

      -- troca de papel. is_local = true, entao o efeito morre no fim
      -- da transacao e nao contamina a sessao de quem rodou o script.
      --
      -- ATENCAO -- o EXECUTE dynamic abaixo e OBRIGATORIO. Nao trocar
      -- por um SELECT comum dentro deste bloco.
      --
      -- O Postgres grava o contexto de RLS e de permissao no PLANO da
      -- query, no momento em que ela e planejada. Um SELECT estatico
      -- aqui dentro seria planejado com o papel de quem executou o
      -- script, devolveria as linhas REAIS e este arquivo acusaria um
      -- vazamento que nao existe.
      --
      -- Ja aconteceu nesta auditoria (2026-10-04): um probe com CTE
      -- devolveu 48 coupons / 37 users para "anon". Era artefato de
      -- planejamento. Com EXECUTE dynamic o numero correto e 0.
      --
      -- Como verificar que este script ainda funciona, e nao virou um
      -- teste vazio: troque 'anon' por 'service_role' no set_config
      -- abaixo. Ele DEVE acusar vazamento em ~25 tabelas. Se nao
      -- acusar, o detector quebrou.
      PERFORM set_config('role', v_papel, true);

      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', v_tabela) INTO v_n;

        IF v_n > 0 THEN
          v_falhas := v_falhas || (v_papel || ' -> ' || v_tabela || ' = ' || v_n || ' linha(s)');
        END IF;
      EXCEPTION WHEN insufficient_privilege THEN
        -- 42501: o papel nem tem SELECT. Mais forte que RLS negar,
        -- porque a negacao acontece na camada de GRANT.
        v_negadas := v_negadas || (v_papel || ' -> ' || v_tabela);
      END;

      PERFORM set_config('role', 'postgres', true);
    END LOOP;
  END LOOP;

  RAISE NOTICE '--- tabelas fechadas por GRANT (42501, estado mais estricto) ---';
  FOREACH v_aviso IN ARRAY v_negadas LOOP RAISE NOTICE '  %', v_aviso; END LOOP;

  RAISE NOTICE '--- tabelas que devolveram linhas (VAZIO = correto) ---';
  FOREACH v_aviso IN ARRAY v_falhas LOOP RAISE NOTICE '  %', v_aviso; END LOOP;

  IF array_length(v_abertas, 1) IS NOT NULL THEN
    RAISE NOTICE '--- tabelas de negocio SEM RLS ---';
    FOREACH v_aviso IN ARRAY v_abertas LOOP RAISE NOTICE '  %', v_aviso; END LOOP;
  END IF;

  -- Este e o portao. Nao comente nem apague a linha abaixo, e nao
  -- amplie a lista de excecoes sem escrever antes a decisao em
  -- SECURITY-DECISIONS.md.
  IF array_length(v_falhas, 1) > 0 OR array_length(v_abertas, 1) > 0 THEN
    RAISE EXCEPTION E'FALHA DE ISOLAMENTO.\nvazamento: %\nsem RLS: %\nO app usa service_role e nao depende de RLS, mas vazamento aqui\nsignifica que a barreira acidental caiu. Reverta o que mudou.',
      array_to_string(v_falhas, ', '), array_to_string(v_abertas, ', ');
  END IF;

  RAISE NOTICE 'OK: anon e authenticated nao leem nenhuma tabela de negocio.';
END
$verify$;
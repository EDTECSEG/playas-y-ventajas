-- ============================================================
-- Playas y Ventajas - Security Hardening (SQL recomendado)
-- ============================================================
-- Este arquivo contém reforços que DEVEM rodar no banco Supabase
-- (SQL Editor). Alguns trechos são recomendações condicionais:
-- valide contra o schema real antes de executar.
--
-- Motivação:
--  * O rate limit em memória nas functions (login.js) é apenas um
--    primeiro filtro por instância e não sobrevive a cold starts.
--  * O controle definitivo de tentativas de login deve viver no RPC
--    auth_login (banco), valendo para todas as instâncias.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Bloqueio de tentativas de login no próprio banco
--    (backoff exponencial por código interno + IP-like fingerprint)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key     TEXT PRIMARY KEY,        -- 'tenant\0internal_code' ou origem
  fails           INT  NOT NULL DEFAULT 0,
  blocked_until   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Limpa janelas antigas periodicamente (ex.: a cada chamada)
DELETE FROM login_attempts WHERE blocked_until IS NOT NULL AND blocked_until < now() - interval '1 day';
DELETE FROM login_attempts WHERE blocked_until IS NULL AND updated_at < now() - interval '1 day';

-- Exemplo de uso dentro de auth_login (adaptar ao corpo atual do RPC):
--
--   DECLARE
--     v_key      TEXT  := p_internal_code;
--     v_attempt  login_attempts%ROWTYPE;
--     v_max      INT   := 5;
--     v_window   INTERVAL := interval '15 minutes';
--   BEGIN
--     SELECT * INTO v_attempt FROM login_attempts WHERE attempt_key = v_key FOR UPDATE;
--
--     IF v_attempt.blocked_until IS NOT NULL AND v_attempt.blocked_until > now() THEN
--       RETURN (SELECT jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'));
--     END IF;
--
--     IF p_pin IS DISTINCT FROM (SELECT pin FROM users WHERE internal_code = p_internal_code) THEN
--       INSERT INTO login_attempts(attempt_key, fails, blocked_until, updated_at)
--       VALUES (v_key, 1, NULL, now())
--       ON CONFLICT (attempt_key) DO UPDATE
--         SET fails = login_attempts.fails + 1,
--             blocked_until = CASE WHEN login_attempts.fails + 1 >= v_max THEN now() + v_window END,
--             updated_at = now();
--       RETURN (SELECT jsonb_build_object('error', 'INVALID_CREDENTIALS'));
--     END IF;
--
--     DELETE FROM login_attempts WHERE attempt_key = v_key;
--   END;

-- ------------------------------------------------------------
-- 2) RLS: o anon NÃO pode ler dados sensíveis do cliente direto via REST
--    (a única porta de acesso DEVE ser as functions com service-role).
--    Confira se estes objetos existem no seu schema antes de rodar:
-- ------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'users', 'businesses', 'coupon_templates', 'customer_coupons',
        'customers', 'campaigns', 'sessions', 'billing', 'business_balance'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   format('anon_all_%s', r.table_name), r.table_name);
  END LOOP;
END $$;

-- As functions/serviços usam a service-role key (bypassa RLS), então produzir
-- um policy nova aqui só é necessário se o frontend acessar o PostgREST com
-- a anon key. Se for o caso, crie policies explícitas e restritas.

-- ------------------------------------------------------------
-- 3) Validação de cupom manual: recomendação pendente
--    (ver SECURITY-DECISIONS.md). Quando a validação manual for
--    removida, desative:
--    UPDATE coupon_validation_config ... (se existir tabela de config)
--    ou simplesmente mantenha apenas validate_and_redeem_coupon.
-- ------------------------------------------------------------

-- Fim. Rode e, se houver dúvida sobre nomes de tabelas/colunas,
-- consulte o schema em Settings > API > Table Editor.
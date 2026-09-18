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
-- ------------------------------------------------------------
-- ESTADO ATUAL (verificado no Supabase em 18/09/2026):
--   a tabela login_attempts JÁ EXISTE neste schema:
--     tenant_id     uuid
--     internal_code text
--     fail_count    integer
--     locked_until  timestamptz
--   e o RPC auth_login JÁ implementa o bloqueio:
--     * 5 falhas seguidas => locked_until = now() + 5 minutes
--     * sucesso => apaga a linha de tentativas
--     * retorno ACCOUNT_LOCKED enquanto bloqueado
-- Os reforços abaixo são idempotentes e apenas GARANTEM o estado
-- esperado (colunas e índice) + limpeza periódica de linhas antigas.
-- ------------------------------------------------------------
ALTER TABLE login_attempts
  ADD COLUMN IF NOT EXISTS fail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS login_attempts_tenant_code_key
  ON login_attempts (tenant_id, internal_code);

-- Limpa janelas antigas periodicamente (ex.: rodar no agendador ou na
-- primeira chamada de auth_login). Sem `updated_at`/`created_at` nesta tabela,
-- limpa apenas por locked_until:
DELETE FROM login_attempts
WHERE locked_until IS NOT NULL AND locked_until < now() - interval '1 day';

-- MELHORIA RECOMENDADA (opcional) no auth_login, além do que já existe:
-- bloquear também por ORIGEM/IP para frustrar brute-force distribuído
-- entre vários códigos internos. Exigiria passar o IP como argumento do RPC
-- (as functions já capturam cf-connecting-ip/x-forwarded-for).

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
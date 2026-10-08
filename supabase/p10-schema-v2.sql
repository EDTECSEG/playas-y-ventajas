-- =============================================================================
-- p10-schema-v2.sql — Rebuild do schema (Plano p10, Caminho A)
-- Projeto Supabase: lztnndomvtmfmooserjr (playas-y-ventajas)
--
-- Aplicar ANTES de p10-functions-v2.sql e p10-seed.sql. Janela de manutencao:
-- entre este arquivo e o replay de funcoes, chamadas do front podem falhar
-- (tabelas antigas ja nao existem, funcoes antigas ainda referenciam).
--
-- 1. Drop das tabelas substituidas (nenhuma FK/VIEW/trigger referencia essas
--    tabelas — verificado em pg_depend/pg_rewrite/pg_get_constraint).
-- 2. Drop das colunas removidas (uso verificado: apenas em funcoes que serao
--    reescritas; o front nao faz select nelas).
-- 3. sessions unificada (user + driver), token uuid PK — mesmo contrato.
-- 4. login_attempts reestruturada (subject_kind/subject_key; PK corrigida).
-- 5. magic_tokens (substitui business_invites + driver_registration_tokens;
--    guarda apenas hash sha256 do codigo).
-- 6. FKs novas de integridade (referrals/outbound -> coupons, ON DELETE SET NULL).
-- 7. RLS habilitado SEM politicas (fiel ao atual: deny-all para anon/auth;
--    service_role tem BYPASSRLS).
-- 8. Grants de tabela fiéis: ALL para anon, authenticated e service_role.
--
-- Nao mexe: cron purge_expired_idempotency_keys; trigger
-- trg_referral_reward_link (corpo usa status/affiliate_id/reward_coupon_id,
-- nao referral_code); tabela idempotency_keys_secret.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabelas substituidas
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.driver_sessions;
DROP TABLE IF EXISTS public.business_invites;
DROP TABLE IF EXISTS public.driver_registration_tokens;
DROP TABLE IF EXISTS public.login_attempts;
DROP TABLE IF EXISTS public.sessions;

-- -----------------------------------------------------------------------------
-- 2. Colunas removidas
-- -----------------------------------------------------------------------------
ALTER TABLE public.businesses DROP COLUMN IF EXISTS authorized_staff_user_ids;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS free_coupons_used;
ALTER TABLE public.coupon_templates DROP COLUMN IF EXISTS issued_count;
ALTER TABLE public.referrals DROP COLUMN IF EXISTS referral_code;
ALTER TABLE public.tenants DROP COLUMN IF EXISTS enabled_modules;
ALTER TABLE public.tenants DROP COLUMN IF EXISTS plan;
ALTER TABLE public.tenants DROP COLUMN IF EXISTS limits;

-- -----------------------------------------------------------------------------
-- 3. sessions unificada (user + driver)
--    - kind='user':  user_id NOT NULL, expira em 12h (default, igual ao antigo).
--    - kind='driver': driver_id NOT NULL, expira em 30d (driver_login grava
--      explicitamente; o antigo driver_sessions tinha default 30 days).
--    - Sem ON DELETE (fiel ao antigo: NO ACTION).
-- -----------------------------------------------------------------------------
CREATE TABLE public.sessions (
  token      uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL,
  user_id    uuid,
  driver_id  uuid,
  kind       text        NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + '12:00:00'::interval),
  CONSTRAINT sessions_pkey PRIMARY KEY (token),
  CONSTRAINT sessions_kind_ck CHECK (kind IN ('user', 'driver')),
  CONSTRAINT sessions_user_ck CHECK (kind <> 'user' OR user_id IS NOT NULL),
  CONSTRAINT sessions_driver_ck CHECK (kind <> 'driver' OR driver_id IS NOT NULL),
  CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id),
  CONSTRAINT sessions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers (id)
);

CREATE INDEX idx_sessions_expires ON public.sessions (expires_at);
CREATE INDEX idx_sessions_tenant_id ON public.sessions (tenant_id);
CREATE INDEX idx_sessions_user_id ON public.sessions (user_id);
CREATE INDEX idx_sessions_driver_id ON public.sessions (driver_id);

-- -----------------------------------------------------------------------------
-- 4. login_attempts (PK antiga tinha colunas duplicadas no dump; corrigida)
-- -----------------------------------------------------------------------------
CREATE TABLE public.login_attempts (
  tenant_id    uuid        NOT NULL,
  subject_kind text        NOT NULL,
  subject_key  text        NOT NULL,
  fail_count   integer     NOT NULL DEFAULT 0,
  locked_until timestamptz,
  CONSTRAINT login_attempts_pkey PRIMARY KEY (tenant_id, subject_kind, subject_key),
  CONSTRAINT login_attempts_subject_kind_ck CHECK (subject_kind IN ('user', 'driver'))
);

-- -----------------------------------------------------------------------------
-- 5. magic_tokens (business_invites + driver_registration_tokens)
--    purpose preserva as strings originais: 'pin' e 'upload' vieram de
--    driver_registration_tokens; 'business_invite' e o novo nome para o codigo
--    de convite (antes coluna code em texto puro; agora so o hash).
-- -----------------------------------------------------------------------------
CREATE TABLE public.magic_tokens (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  purpose     text        NOT NULL,
  token_hash  text        NOT NULL,
  driver_id   uuid,
  business_id uuid,
  created_by  uuid,
  max_uses    integer     NOT NULL DEFAULT 1,
  uses        integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT magic_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT magic_tokens_purpose_ck CHECK (purpose IN ('business_invite', 'pin', 'upload')),
  CONSTRAINT magic_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants (id),
  CONSTRAINT magic_tokens_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers (id),
  CONSTRAINT magic_tokens_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses (id),
  CONSTRAINT magic_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id)
);

CREATE UNIQUE INDEX magic_tokens_tenant_purpose_hash_uniq
  ON public.magic_tokens (tenant_id, purpose, token_hash);
CREATE INDEX magic_tokens_invite_lookup_idx
  ON public.magic_tokens (tenant_id, token_hash)
  WHERE purpose = 'business_invite' AND revoked_at IS NULL;
CREATE INDEX magic_tokens_driver_idx ON public.magic_tokens (driver_id, purpose);
CREATE INDEX magic_tokens_tenant_id_idx ON public.magic_tokens (tenant_id);
CREATE INDEX magic_tokens_business_id_idx ON public.magic_tokens (business_id);
CREATE INDEX magic_tokens_created_by_idx ON public.magic_tokens (created_by);

-- -----------------------------------------------------------------------------
-- 6. FKs novas de integridade (antes eram colunas soltas)
--    3 linhas de outbound_messages apontam para coupon_id inexistente (dump
--    confirmado) — viram NULL antes da constraint, coerente com ON DELETE SET NULL.
-- -----------------------------------------------------------------------------
UPDATE public.outbound_messages
   SET coupon_id = NULL
 WHERE coupon_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.coupons c WHERE c.id = public.outbound_messages.coupon_id);

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_reward_coupon_id_fkey
  FOREIGN KEY (reward_coupon_id) REFERENCES public.coupons (id) ON DELETE SET NULL;

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_welcome_coupon_id_fkey
  FOREIGN KEY (welcome_coupon_id) REFERENCES public.coupons (id) ON DELETE SET NULL;

ALTER TABLE public.outbound_messages
  ADD CONSTRAINT outbound_messages_coupon_id_fkey
  FOREIGN KEY (coupon_id) REFERENCES public.coupons (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 7. RLS sem politicas (fiel: deny-all para anon/auth; service_role bypassa)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.magic_tokens ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 8. Grants de tabela fiéis (todas as tabelas de app: ALL p/ os 3 roles)
-- -----------------------------------------------------------------------------
GRANT ALL ON TABLE public.sessions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.login_attempts TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.magic_tokens TO anon, authenticated, service_role;

COMMENT ON TABLE public.sessions IS
  'Sessoes unificadas: kind=user (12h) e kind=driver (30d). Substitui sessions + driver_sessions.';
COMMENT ON TABLE public.magic_tokens IS
  'Tokens de uso unico (business_invite, pin, upload). Substitui business_invites + driver_registration_tokens; guarda apenas sha256.';
COMMENT ON TABLE public.login_attempts IS
  'Lockout de login por (tenant_id, subject_kind, subject_key).';

COMMIT;

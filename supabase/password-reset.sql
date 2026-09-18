-- ============================================================
-- Playas y Ventajas - Reset de senha da empresa (admin)
-- ============================================================
-- Objetivo: no painel Admin, o botão "Resetar senha" de uma empresa
-- gera uma senha temporária (PIN) para o MERCHANT dono do negócio.
-- Ao logar, o painel da empresa DETECTA o flag must_change_pin e
-- OBRIGA a definir uma nova senha antes de liberar o dashboard.
--
-- Como usar (SQL Editor do Supabase):
--   * rode o arquivo inteiro
--   * o admin clica em "Resetar senha" no painel -> o RPC devolve o
--     PIN temporário (6 dígitos) que o admin repassa à empresa
-- ============================================================

-- ------------------------------------------------------------
-- 1) Flag de troca obrigatória de senha no usuário
-- ------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_pin boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 2) Admin gera a senha temporária de um negócio
--    Somente ADMIN/SUPER_ADMIN. Altera o pin_hash para o PIN
--    temporário e marca must_change_pin=true.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_request_password_reset(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_business_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_temp_pin text;
  v_updated  int;
BEGIN
  SELECT role INTO v_role
  FROM public.users
  WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;

  IF v_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  v_temp_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');

  UPDATE public.users
  SET pin_hash = encode(digest(v_temp_pin, 'sha256'), 'hex'),
      must_change_pin = true
  WHERE tenant_id = p_tenant_id
    AND business_id = p_business_id
    AND role = 'MERCHANT';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'NO_MERCHANT_FOR_BUSINESS';
  END IF;

  RETURN v_temp_pin;
END;
$$;

-- ------------------------------------------------------------
-- 3) Informa se o usuário precisa trocar a senha (usado no login)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_pin_reset_required(p_user_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT must_change_pin FROM public.users WHERE id = p_user_id),
    false
  );
$$;

-- ------------------------------------------------------------
-- 4) Empresa define a nova senha definitiva
--    Exige que must_change_pin esteja ativo (veio de um reset).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_set_pin(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_new_pin text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_reset boolean;
  v_count int;
BEGIN
  IF p_new_pin IS NULL OR length(p_new_pin) < 6 THEN
    RAISE EXCEPTION 'PIN_TOO_SHORT';
  END IF;

  SELECT must_change_pin INTO v_reset
  FROM public.users
  WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;

  IF NOT COALESCE(v_reset, false) THEN
    RAISE EXCEPTION 'RESET_NOT_REQUESTED';
  END IF;

  UPDATE public.users
  SET pin_hash = encode(digest(p_new_pin, 'sha256'), 'hex'),
      must_change_pin = false
  WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
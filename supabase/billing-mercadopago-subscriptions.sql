-- ============================================================================
-- billing-mercadopago-subscriptions.sql
--
-- Assinatura mensal via Mercado Pago (v1): fluxo "pending" + init_point.
-- Decisão do dono (2026-09-28): gateway = Mercado Pago, cobrança mensal
-- recorrente; taxa por cupom fica para fase 2.
--
-- O que este arquivo faz:
--   1) businesses  -> billing_provider, billing_subscription_id (único, parcial),
--                     billing_subscription_url (init_point p/ reabrir o checkout).
--   2) billing_charges -> coupon_id vira NULL-able (cobrança recorrente não tem
--                     cupom), ganha provider/provider_payment_id com índice
--                     único parcial para dedupe de webhook.
--   3) Funções SECURITY DEFINER:
--        billing_mp_prepare          - valida ator/empresa/plano e devolve o
--                                      payload da preapproval; se já existe
--                                      assinatura, devolve o url guardado.
--        billing_mp_register         - grava subscription_id/url após criar no MP.
--        billing_mp_cancel           - limpa a assinatura e marca CANCELLED.
--        billing_mp_webhook_preapproval - atualiza billing_status pelo status
--                                      da assinatura (authorized/cancelled).
--        billing_mp_webhook_charge   - registra 1 cobrança por pagamento
--                                      (dedupe por provider_payment_id) e ativa.
--   4) EXECUTE fechado para PUBLIC/anon/authenticated, só service_role (padrão
--      reclose-function-exec-r2.sql). Webhook/negócio chamam via service_role.
--
-- ATENÇÃO: os webhooks NÃO passam ator — a autenticação deles é o HMAC do
-- header x-signature validado na função billing-webhook. As funções de webhook
-- são inalcançáveis pelo cliente porque o EXECUTE está fechado.
-- ============================================================================

-- ------------------------------------------------------------
-- 1) businesses: campos da assinatura externa
-- ------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS billing_provider text,
  ADD COLUMN IF NOT EXISTS billing_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_subscription_url text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_billing_subscription_id
  ON public.businesses (billing_subscription_id)
  WHERE billing_subscription_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2) billing_charges: cobrança recorrente (sem cupom) + dedupe de webhook
-- ------------------------------------------------------------
ALTER TABLE public.billing_charges
  ALTER COLUMN coupon_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_charges_provider_payment
  ON public.billing_charges (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3a) billing_mp_prepare — valida e devolve o payload da criação
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_prepare(
  p_tenant_id uuid,
  p_business_id uuid,
  p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor    users%rowtype;
  v_business businesses%rowtype;
  v_fee      numeric(10,2);
  v_owner_email text;
BEGIN
  SELECT * INTO v_actor FROM users WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;
  IF NOT found
     OR v_actor.role NOT IN ('MERCHANT','ADMIN','SUPER_ADMIN')
     OR (v_actor.role = 'MERCHANT' AND v_actor.business_id IS DISTINCT FROM p_business_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_business FROM businesses WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN RAISE EXCEPTION 'BUSINESS_NOT_FOUND'; END IF;

  IF v_business.billing_plan IS NULL OR v_business.billing_plan = 'FREE' THEN
    RAISE EXCEPTION 'PLAN_REQUIRES_FEE';
  END IF;
  IF v_business.monthly_fee_cents IS NULL
     OR v_business.monthly_fee_cents < 100
     OR v_business.monthly_fee_cents > 1000000 THEN
    RAISE EXCEPTION 'INVALID_FEE';
  END IF;
  v_fee := (v_business.monthly_fee_cents::numeric) / 100.0;

  SELECT email INTO v_owner_email FROM users WHERE id = v_business.owner_user_id;

  IF v_business.billing_subscription_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'businessId', v_business.id,
      'tenantId', p_tenant_id,
      'ownerEmail', v_owner_email,
      'businessName', v_business.name,
      'transactionAmount', v_fee,
      'reason', v_business.name || ' - Plano ' || v_business.billing_plan,
      'subscriptionId', v_business.billing_subscription_id,
      'subscriptionUrl', v_business.billing_subscription_url
    );
  END IF;

  RETURN jsonb_build_object(
    'businessId', v_business.id,
    'tenantId', p_tenant_id,
    'ownerEmail', v_owner_email,
    'businessName', v_business.name,
    'transactionAmount', v_fee,
    'reason', v_business.name || ' - Plano ' || v_business.billing_plan
  );
END;
$$;

-- ------------------------------------------------------------
-- 3b) billing_mp_register — grava a assinatura criada no MP
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_register(
  p_tenant_id uuid,
  p_business_id uuid,
  p_actor_user_id uuid,
  p_subscription_id text,
  p_subscription_url text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor users%rowtype;
BEGIN
  IF p_subscription_id IS NULL OR p_subscription_id !~ '^[0-9a-fA-F]{24}$' THEN
    RAISE EXCEPTION 'INVALID_SUBSCRIPTION_ID';
  END IF;
  IF p_subscription_url IS NULL OR p_subscription_url !~ '^https://' THEN
    RAISE EXCEPTION 'INVALID_URL';
  END IF;

  SELECT * INTO v_actor FROM users WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;
  IF NOT found
     OR v_actor.role NOT IN ('MERCHANT','ADMIN','SUPER_ADMIN')
     OR (v_actor.role = 'MERCHANT' AND v_actor.business_id IS DISTINCT FROM p_business_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- business precisa existir no tenant; a assinatura é única por índice parcial
  UPDATE businesses
     SET billing_provider = 'mercadopago',
         billing_subscription_id = p_subscription_id,
         billing_subscription_url = p_subscription_url
   WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN RAISE EXCEPTION 'BUSINESS_NOT_FOUND'; END IF;
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- 3c) billing_mp_cancel — encerra a assinatura local
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_cancel(
  p_tenant_id uuid,
  p_business_id uuid,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor users%rowtype;
BEGIN
  SELECT * INTO v_actor FROM users WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;
  IF NOT found
     OR v_actor.role NOT IN ('MERCHANT','ADMIN','SUPER_ADMIN')
     OR (v_actor.role = 'MERCHANT' AND v_actor.business_id IS DISTINCT FROM p_business_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE businesses
     SET billing_subscription_id = NULL,
         billing_subscription_url = NULL,
         billing_status = 'CANCELLED'
   WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN RAISE EXCEPTION 'BUSINESS_NOT_FOUND'; END IF;
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- 3d) billing_mp_webhook_preapproval — evento subscription_preapproval
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_webhook_preapproval(
  p_subscription_id text,
  p_status text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF p_subscription_id IS NULL OR p_subscription_id !~ '^[0-9a-fA-F]{24}$' THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE billing_subscription_id = p_subscription_id) THEN
    RETURN false;
  END IF;

  CASE p_status
    WHEN 'authorized' THEN
      UPDATE businesses SET billing_status = 'ACTIVE' WHERE billing_subscription_id = p_subscription_id;
    WHEN 'cancelled' THEN
      UPDATE businesses SET billing_status = 'CANCELLED' WHERE billing_subscription_id = p_subscription_id;
    ELSE
      RETURN true; -- pending / paused: sem efeito no status de negócio
  END CASE;
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- 3e) billing_mp_webhook_charge — evento subscription_authorized_payment
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_webhook_charge(
  p_subscription_id text,
  p_payment_id text,
  p_amount_cents int
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_business businesses%rowtype;
BEGIN
  IF p_subscription_id IS NULL OR p_subscription_id !~ '^[0-9a-fA-F]{24}$' THEN
    RETURN false;
  END IF;
  IF p_payment_id IS NULL OR p_payment_id !~ '^[0-9a-fA-F]{6,40}$' THEN
    RETURN false;
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT * INTO v_business FROM businesses WHERE billing_subscription_id = p_subscription_id;
  IF NOT found THEN RETURN false; END IF;

  -- Dedupe de retry do webhook: uma cobrança entra uma única vez.
  INSERT INTO billing_charges (tenant_id, business_id, coupon_id, amount_cents, created_at, provider, provider_payment_id)
  VALUES (v_business.tenant_id, v_business.id, NULL, p_amount_cents, now(), 'mercadopago', p_payment_id)
  ON CONFLICT (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL
    DO NOTHING;

  -- Pagamento chegou: negócio está pagante.
  UPDATE businesses
     SET billing_status = 'ACTIVE'
   WHERE id = v_business.id AND billing_status IS DISTINCT FROM 'ACTIVE';
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- 4) ACL: fecha EXECUTE para o cliente; só service_role executa
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.billing_mp_prepare(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_prepare(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_register(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_register(uuid,uuid,uuid,text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_cancel(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_cancel(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_webhook_preapproval(text,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_webhook_preapproval(text,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_webhook_charge(text,text,int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_webhook_charge(text,text,int) TO service_role;

-- ------------------------------------------------------------
-- 5) Verificação: nenhuma das funções novas pode estar aberta ao cliente
-- ------------------------------------------------------------
SELECT p.proname,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
         WHERE x.privilege_type = 'EXECUTE' AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
       )) AS aberta_ao_cliente
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('billing_mp_prepare','billing_mp_register','billing_mp_cancel',
                     'billing_mp_webhook_preapproval','billing_mp_webhook_charge')
 GROUP BY p.proname
 ORDER BY p.proname;
-- ============================================================================
-- p2-taxa-por-cupom.sql
--
-- Fase 2 do billing: TAXA POR CUPOM.
-- Decisão do dono (2026-09-29):
--   * Evento cobrável: RESGATE (claim_coupon). Cada cupom emitido gera a taxa.
--   * Representação: billing_plan = 'PER_COUPON' + coluna billing_fee_cents.
--   * Destino: linha em billing_charges (coupon_id preenchido); cobrança manual
--     pelo admin; total aparece no painel via admin_billing_panel.
--
-- O que este arquivo faz:
--   1) businesses -> billing_fee_cents (taxa por cupom, em centavos).
--   2) Índice único parcial billing_charges(coupon_id): 1 taxa por cupom
--      emitido; retry de claim não duplica cobrança.
--   3) billing_record_coupon_tax — grava a taxa quando a empresa está em
--      PER_COUPON. Resolve a empresa pelo template no servidor (nunca pelo
--      businessId enviado pelo cliente) e é idempotente (ON CONFLICT).
--   4) billing_mp_prepare — passa a recusar PER_COUPON (PLAN_NOT_SUBSCRIPTION):
--      plano por cupom não assina mensalidade no Mercado Pago.
--   5) admin_set_billing — roteia a fee pelo plano: PER_COUPON grava em
--      billing_fee_cents; planos mensais continuam gravando monthly_fee_cents.
--   6) admin_list_businesses — passa a devolver billingFeeCents para o painel.
--   7) ACL fechada para PUBLIC/anon/authenticated; só service_role executa.
--
-- O hook é chamado pelo handler claim-coupon.js logo após claim_coupon (caminho
-- crítico intocado), best-effort: se a taxa falhar, o resgate já aconteceu.
-- ============================================================================

-- ------------------------------------------------------------
-- 1) businesses: taxa por cupom (centavos)
-- ------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS billing_fee_cents integer NOT NULL DEFAULT 0;

-- Regra de negócio: permite o plano por cupom no CHECK existente.
ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_billing_plan_check;
ALTER TABLE public.businesses ADD CONSTRAINT businesses_billing_plan_check
  CHECK (billing_plan = ANY (ARRAY['FREE'::text, 'BASIC'::text, 'PRO'::text, 'PER_COUPON'::text]));

-- ------------------------------------------------------------
-- 2) dedupe: 1 taxa por cupom emitido (coupon_id = linha única de coupons)
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_charges_coupon_id
  ON public.billing_charges (coupon_id)
  WHERE coupon_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3a) billing_record_coupon_tax — grava a taxa por cupom (idempotente)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_record_coupon_tax(
  p_tenant_id uuid,
  p_template_id uuid,
  p_coupon_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_business  businesses%rowtype;
  v_inserted  int;
BEGIN
  IF p_tenant_id IS NULL OR p_template_id IS NULL OR p_coupon_id IS NULL THEN
    RETURN false;
  END IF;

  -- Empresa resolvida pelo template no banco; o cliente não escolhe businessId.
  SELECT b.* INTO v_business
    FROM businesses b
    JOIN coupon_templates ct ON ct.business_id = b.id AND ct.tenant_id = b.tenant_id
   WHERE ct.id = p_template_id
     AND ct.tenant_id = p_tenant_id
   LIMIT 1;
  IF NOT found THEN RETURN false; END IF;

  -- Só empresa em plano por cupom paga taxa; fee zerado/inválido = sem cobrança.
  IF v_business.billing_plan IS DISTINCT FROM 'PER_COUPON' THEN RETURN false; END IF;
  IF v_business.billing_fee_cents IS NULL
     OR v_business.billing_fee_cents < 1
     OR v_business.billing_fee_cents > 1000000 THEN
    RETURN false;
  END IF;

  INSERT INTO billing_charges (tenant_id, business_id, coupon_id, amount_cents)
  VALUES (v_business.tenant_id, v_business.id, p_coupon_id, v_business.billing_fee_cents)
  ON CONFLICT (coupon_id) WHERE coupon_id IS NOT NULL DO NOTHING
  RETURNING 1 INTO v_inserted;

  RETURN COALESCE(v_inserted = 1, false);
END;
$$;

-- ------------------------------------------------------------
-- 3b) billing_mp_prepare — PER_COUPON não assina mensalidade
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
  -- Plano por cupom não assina mensalidade: a cobrança é por resgate.
  IF v_business.billing_plan = 'PER_COUPON' THEN
    RAISE EXCEPTION 'PLAN_NOT_SUBSCRIPTION';
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
-- 3c) admin_set_billing — roteia a fee pelo plano
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_billing(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_plan text, p_status text, p_fee_cents integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if p_fee_cents is null or p_fee_cents < 0 or p_fee_cents > 1000000 then raise exception 'INVALID_FEE'; end if;
  if p_plan = 'PER_COUPON' then
    update businesses
       set billing_plan = p_plan, billing_status = coalesce(p_status, 'ACTIVE'),
           monthly_fee_cents = 0, billing_fee_cents = p_fee_cents
     where id = p_business_id and tenant_id = p_tenant_id;
  else
    update businesses
       set billing_plan = p_plan, billing_status = p_status,
           monthly_fee_cents = p_fee_cents, billing_fee_cents = 0
     where id = p_business_id and tenant_id = p_tenant_id;
  end if;
end $function$;

-- ------------------------------------------------------------
-- 3d) admin_list_businesses — devolve billingFeeCents ao painel
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_businesses(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.name, 'category', b.category, 'city', b.city, 'phone', b.phone, 'email', b.email,
    'cnpj', b.cnpj, 'website', b.website, 'logoUrl', b.logo_url,
    'lat', ST_Y(b.location::geometry), 'lng', ST_X(b.location::geometry), 'isActive', b.is_active,
    'billingPlan', b.billing_plan, 'billingStatus', b.billing_status,
    'monthlyFeeCents', b.monthly_fee_cents, 'billingFeeCents', b.billing_fee_cents,
    'ownerInternalCode', u.internal_code
  ) order by b.created_at desc), '[]'::jsonb)
  from businesses b join users u on u.id = b.owner_user_id where b.tenant_id = p_tenant_id);
end $function$;

-- ------------------------------------------------------------
-- 4) ACL: fecha EXECUTE para o cliente; só service_role executa
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.billing_record_coupon_tax(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_record_coupon_tax(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_prepare(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.billing_mp_prepare(uuid,uuid,uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_billing(uuid,uuid,uuid,text,text,int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_set_billing(uuid,uuid,uuid,text,text,int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_list_businesses(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_list_businesses(uuid,uuid) TO service_role;

-- ------------------------------------------------------------
-- 5) Verificação: nenhuma das funções pode estar aberta ao cliente
-- ------------------------------------------------------------
SELECT p.proname,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
         WHERE x.privilege_type = 'EXECUTE' AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
       )) AS aberta_ao_cliente
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('billing_record_coupon_tax','billing_mp_prepare','admin_set_billing','admin_list_businesses')
 GROUP BY p.proname
 ORDER BY p.proname;
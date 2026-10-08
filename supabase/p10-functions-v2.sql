-- =============================================================================
-- p10-functions-v2.sql — Replay + rewrites de funcoes (Plano p10)
-- Projeto Supabase: lztnndomvtmfmooserjr (playas-y-ventajas)
--
-- Aplicar APOS p10-schema-v2.sql. Conteudo, nesta ordem:
--   1. DROP de 11 funcoes orfas + 2 sobrecargas stale (13 DROPs exatos)
--   2. Replay verbatim de 73 funcoes do backup (01-funcoes-producao.sql)
--   3. 22 rewrites com assinaturas validadas contra o backup
--      (rewrites-a.sql: 9 contadores/JSON; rewrites-b.sql: 13 sessoes/tokens)
--      Total final: 95 funcoes = 73 replay + 22 rewrites
--   4. Grants explicitos por funcao (Regra 4 do repo: quem recria fecha):
--      REVOKE EXECUTE FROM PUBLIC/anon/authenticated + GRANT TO service_role
--      para as 95 funcoes, replicando o inventario de producao.
--
-- Durante a janela entre este arquivo e o p10-schema, o front pode receber
-- erros em chamadas afetadas — aplicar em manutencao quando possivel.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Funcoes removidas (orfas + sobrecargas stale)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_create_business(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_category text, p_city text, p_phone text, p_email text, p_lat double precision, p_lng double precision, p_owner_internal_code text, p_owner_pin text, p_billing_plan text);
DROP FUNCTION IF EXISTS public.admin_overview(p_tenant_id uuid);
DROP FUNCTION IF EXISTS public.admin_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone);
DROP FUNCTION IF EXISTS public.affiliate_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone);
DROP FUNCTION IF EXISTS public.backfill_affiliate_rewards(p_tenant_id uuid);
DROP FUNCTION IF EXISTS public.create_coupon_template(p_tenant_id uuid, p_business_id uuid, p_campaign_id uuid, p_actor_user_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer);
DROP FUNCTION IF EXISTS public.driver_list_documents(p_tenant_id uuid, p_driver_id uuid, p_session_token uuid);
DROP FUNCTION IF EXISTS public.get_referral_bonus(p_tenant_id uuid, p_customer_id uuid);
DROP FUNCTION IF EXISTS public.issue_coupon_from_template(p_tenant_id uuid, p_template_id uuid, p_actor_user_id uuid, p_customer_id uuid);
DROP FUNCTION IF EXISTS public.list_offers_public(p_tenant_id uuid, p_city text, p_category text, p_lat double precision, p_lng double precision, p_radius_km double precision);
DROP FUNCTION IF EXISTS public.outbound_list(p_tenant_id uuid, p_actor_user_id uuid, p_status text, p_limit integer);
DROP FUNCTION IF EXISTS public.seed_demo_tenant();
DROP FUNCTION IF EXISTS public.set_coupon_proximity(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_lat double precision, p_lng double precision, p_radius_m integer);

-- -----------------------------------------------------------------------------
-- 2. Replay verbatim das funcoes remanescentes (backup prep10, 73 funcoes;
--    as 22 reescritas sao substituidas no passo 3)
-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- admin_affiliate_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_affiliate_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_out jsonb;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.role not in ('ADMIN', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  with contagens as (
    select r.affiliate_id,
           count(*) as total,
           count(*) filter (where r.status = 'converted') as converted,
           count(*) filter (where r.status = 'pending') as pending
    from public.referrals r
    where (p_de is null or r.created_at >= p_de)
      and (p_ate is null or r.created_at < p_ate)
    group by r.affiliate_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'affiliateId', a.id,
      'name', a.name,
      'phone', a.phone,
      'referralCode', a.referral_code,
      'kind', a.kind,
      'rewardStatus', a.reward_status,
      'createdAt', a.created_at,
      'totalReferrals', coalesce(c.total, 0),
      'converted', coalesce(c.converted, 0),
      'pending', coalesce(c.pending, 0)
    ) order by a.created_at desc
  ), '[]'::jsonb)
  into v_out
  from public.affiliates a
  left join contagens c on c.affiliate_id = a.id
  where a.tenant_id = p_tenant_id;

  return v_out;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_billing_panel(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_billing_panel(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'businessName', b.name, 'couponPublicId', co.public_id, 'amountCents', bc.amount_cents, 'validatedAt', co.validated_at
  ) order by bc.created_at desc), '[]'::jsonb)
  from billing_charges bc join businesses b on b.id=bc.business_id join coupons co on co.id=bc.coupon_id
  where bc.tenant_id = p_tenant_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_create_business(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_category text, p_city text, p_phone text, p_email text, p_lat double precision, p_lng double precision, p_owner_internal_code text, p_owner_pin text, p_billing_plan text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_business(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_category text, p_city text, p_phone text, p_email text, p_lat double precision, p_lng double precision, p_owner_internal_code text, p_owner_pin text, p_billing_plan text, p_cnpj text DEFAULT NULL::text, p_website text DEFAULT NULL::text, p_logo_url text DEFAULT NULL::text, p_instagram text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype; v_owner_id uuid; v_business_id uuid;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if length(p_owner_pin) < 6 then raise exception 'WEAK_PIN: minimo de 6 caracteres'; end if;

  select id into v_owner_id from users where tenant_id = p_tenant_id and internal_code=p_owner_internal_code;
  if not found then
    insert into users (tenant_id, internal_code, role, pin_hash)
      values (p_tenant_id, p_owner_internal_code, 'MERCHANT', encode(digest(p_owner_pin,'sha256'),'hex'))
      returning id into v_owner_id;
  end if;

  insert into businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url, instagram)
  values (p_tenant_id, p_name, p_category, p_city, p_phone, p_email,
          case when p_lat is not null and p_lng is not null then ST_MakePoint(p_lng,p_lat)::geography else null end,
          v_owner_id, coalesce(p_billing_plan,'FREE'), 'TRIAL', p_cnpj,
          nullif(btrim(p_website), ''), p_logo_url,
          public.normalize_instagram(p_instagram))
  returning id into v_business_id;

  update users set business_id = v_business_id where id = v_owner_id;
  return jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_delete_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_actor users%rowtype;
  v_business businesses%rowtype;
  v_deleted int;
  v_campaign_ids uuid[] := ARRAY(SELECT c.id FROM campaigns c WHERE c.tenant_id = p_tenant_id AND c.business_id = p_business_id);
  v_template_ids uuid[] := ARRAY(SELECT t.id FROM coupon_templates t WHERE t.tenant_id = p_tenant_id AND t.business_id = p_business_id);
  v_coupon_ids uuid[] := ARRAY(SELECT c.id FROM coupons c WHERE c.tenant_id = p_tenant_id AND c.business_id = p_business_id);
BEGIN
  SELECT * INTO v_actor FROM users WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;
  IF NOT found OR v_actor.role NOT IN ('ADMIN','SUPER_ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_business FROM businesses WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN
    RAISE EXCEPTION 'NOT_FOUND: business';
  END IF;

  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id AND (
    (entity = 'Business' AND entity_id = p_business_id)
    OR (entity = 'Campaign' AND entity_id = ANY(v_campaign_ids))
    OR (entity = 'CouponTemplate' AND entity_id = ANY(v_template_ids))
    OR (entity = 'Coupon' AND entity_id = ANY(v_coupon_ids))
  );
  DELETE FROM public.coupons WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.coupon_templates WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.campaigns WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.billing_charges WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.users WHERE tenant_id = p_tenant_id AND business_id = p_business_id;

  DELETE FROM public.businesses WHERE tenant_id = p_tenant_id AND id = p_business_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- admin_featured_ranks(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_featured_ranks(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor users%rowtype; v_out jsonb;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.role not in ('ADMIN', 'SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'businessId', b.id, 'featuredRank', b.featured_rank
  ) order by b.featured_rank desc, b.name asc), '[]'::jsonb)
  into v_out
  from businesses b
  where b.tenant_id = p_tenant_id;
  return v_out;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_get_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select case when r.id is not null then
    jsonb_build_object(
      'affiliateRewardTemplateId', r.affiliate_reward_template_id,
      'welcomeTemplateId', r.welcome_template_id,
      'requireFirstClaim', r.require_first_claim,
      'updatedAt', r.updated_at
    ) else null end
  from public.affiliate_rewards r
  where r.tenant_id = p_tenant_id
    and exists (
      select 1 from public.users ua
      where ua.id = p_actor_user_id
        and ua.tenant_id = p_tenant_id
        and ua.role in ('ADMIN', 'SUPER_ADMIN')
    );
$function$
;
-- -----------------------------------------------------------------------------
-- admin_list_businesses(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
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
    'cnpj', b.cnpj, 'website', b.website, 'instagram', b.instagram, 'logoUrl', b.logo_url,
    'lat', st_y(b.location::geometry), 'lng', st_x(b.location::geometry), 'isActive', b.is_active,
    'billingPlan', b.billing_plan, 'billingStatus', b.billing_status,
    'monthlyFeeCents', b.monthly_fee_cents, 'billingFeeCents', b.billing_fee_cents,
    'ownerInternalCode', u.internal_code
  ) order by b.created_at desc), '[]'::jsonb)
  from businesses b join users u on u.id = b.owner_user_id where b.tenant_id = p_tenant_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_list_customers(p_tenant_id uuid, p_actor_user_id uuid, p_search text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_customers(p_tenant_id uuid, p_actor_user_id uuid, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'name', u.name, 'phone', u.phone, 'email', u.email, 'instagram', u.instagram,
    'isActive', u.is_active, 'createdAt', u.created_at
  ) order by u.created_at desc), '[]'::jsonb)
  from users u where u.tenant_id = p_tenant_id and u.role = 'CUSTOMER'
    and (p_search is null or u.name ilike '%'||p_search||'%' or u.phone ilike '%'||p_search||'%'));
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_request_password_reset(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) RETURNS text
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_request_password_reset(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- admin_set_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid, p_affiliate_reward_template_id uuid, p_welcome_template_id uuid, p_require_first_claim boolean) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid, p_affiliate_reward_template_id uuid DEFAULT NULL::uuid, p_welcome_template_id uuid DEFAULT NULL::uuid, p_require_first_claim boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_rewards public.affiliate_rewards%rowtype;
begin
  if not exists (
    select 1 from public.users ua
    where ua.id = p_actor_user_id
      and ua.tenant_id = p_tenant_id
      and ua.role in ('ADMIN', 'SUPER_ADMIN')
  ) then
    raise exception 'FORBIDDEN';
  end if;

  update public.affiliate_rewards set
    affiliate_reward_template_id = p_affiliate_reward_template_id,
    welcome_template_id = p_welcome_template_id,
    require_first_claim = p_require_first_claim,
    updated_at = now()
  where tenant_id = p_tenant_id
  returning * into v_rewards;

  if not found then
    insert into public.affiliate_rewards
      (tenant_id, affiliate_reward_template_id, welcome_template_id, require_first_claim)
    values
      (p_tenant_id, p_affiliate_reward_template_id, p_welcome_template_id, p_require_first_claim)
    returning * into v_rewards;
  end if;

  return jsonb_build_object(
    'affiliateRewardTemplateId', v_rewards.affiliate_reward_template_id,
    'welcomeTemplateId', v_rewards.welcome_template_id,
    'requireFirstClaim', v_rewards.require_first_claim
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_set_billing(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_plan text, p_status text, p_fee_cents integer) RETURNS void
-- -----------------------------------------------------------------------------
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
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.role not in ('ADMIN', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;
  update public.coupon_templates
    set featured_until = p_until
    where id = p_template_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'TEMPLATE_NOT_FOUND';
  end if;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_set_featured(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_featured_rank integer) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_featured(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_featured_rank integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.role not in ('ADMIN', 'SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if p_featured_rank < 0 then raise exception 'INVALID_RANK'; end if;
  update businesses set featured_rank = p_featured_rank
  where id = p_business_id and tenant_id = p_tenant_id;
  if not found then raise exception 'BUSINESS_NOT_FOUND'; end if;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_toggle_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_is_active boolean) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_toggle_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  update businesses set is_active = p_is_active where id = p_business_id and tenant_id = p_tenant_id;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_update_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_name text, p_phone text, p_email text, p_category text, p_city text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_name text, p_phone text, p_email text, p_category text, p_city text, p_cnpj text, p_website text, p_logo_url text, p_instagram text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  -- `coalesce` nos campos antigos: vazio ja entrava como NULL do worker.
  -- `case` nos novos: NULL = manter, '' = limpar (ver decisao 4 no cabecalho).
  update businesses set name=coalesce(p_name,name), phone=coalesce(p_phone,phone), email=coalesce(p_email,email),
    category=coalesce(p_category,category), city=coalesce(p_city,city), cnpj=coalesce(p_cnpj,cnpj),
    website=coalesce(p_website,website), logo_url=coalesce(p_logo_url,logo_url),
    instagram=case when p_instagram is null then instagram else public.normalize_instagram(p_instagram) end
    where id=p_business_id and tenant_id=p_tenant_id;
end $function$
;
-- -----------------------------------------------------------------------------
-- admin_update_customer(p_tenant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_name text, p_email text, p_instagram text, p_is_active boolean) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_customer(p_tenant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_name text, p_email text, p_instagram text, p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  update users set name=coalesce(p_name,name), email=coalesce(p_email,email), instagram=coalesce(p_instagram,instagram), is_active=coalesce(p_is_active,is_active)
    where id=p_customer_id and tenant_id=p_tenant_id and role='CUSTOMER';
end $function$
;
-- -----------------------------------------------------------------------------
-- affiliate_dashboard(p_tenant_id uuid, p_affiliate_id uuid, p_phone text, p_de timestamp with time zone, p_ate timestamp with time zone) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_dashboard(p_tenant_id uuid, p_affiliate_id uuid, p_phone text, p_de timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  with indicacoes as (
    select r.id, r.status, r.created_at, r.converted_at, r.reward_coupon_id,
           u.name as referred_name, u.phone as referred_phone,
           c.public_id, c.status as coupon_status, c.issued_at, c.validated_at,
           t.title, t.benefit_type, t.benefit_value, biz.name as business_name,
           premio.public_id as reward_public_id
    from public.referrals r
    left join public.users u on u.id = r.referred_user_id
    left join lateral (
      select co.public_id, co.status, co.issued_at, co.validated_at, co.template_id, co.business_id
      from public.coupons co
      where co.customer_id = r.referred_user_id and co.issued_at >= r.created_at
      order by co.issued_at asc limit 1
    ) c on true
    left join public.coupon_templates t on t.id = c.template_id
    left join public.businesses biz on biz.id = c.business_id
    left join public.coupons premio on premio.id = r.reward_coupon_id
    where r.tenant_id = p_tenant_id
      and r.affiliate_id = p_affiliate_id
      and (p_de is null or r.created_at >= p_de)
      and (p_ate is null or r.created_at < p_ate)
  )
  select jsonb_build_object(
    'affiliateId', a.id, 'name', a.name, 'phone', a.phone,
    'referralCode', a.referral_code, 'kind', a.kind,
    'rewardStatus', a.reward_status, 'createdAt', a.created_at,
    'totalReferrals', count(i.id),
    'converted', count(i.id) filter (where i.status = 'converted'),
    'pending', count(i.id) filter (where i.status = 'pending'),
    'rewardCoupons', count(i.id) filter (where i.reward_coupon_id is not null),
    'cuponsPegos', count(i.id) filter (where i.public_id is not null),
    'cuponsResgatados', count(i.id) filter (where i.validated_at is not null),
    'referrals', coalesce(jsonb_agg(
      jsonb_build_object('id', i.id, 'status', i.status, 'convertedAt', i.converted_at,
        'createdAt', i.created_at, 'referredName', i.referred_name, 'referredPhone', i.referred_phone)
      order by i.created_at desc
    ) filter (where i.id is not null), '[]'::jsonb),
    'resgates', coalesce(jsonb_agg(
      jsonb_build_object('id', i.id, 'status', i.status, 'indicado', i.referred_name,
        'telefone', i.referred_phone, 'indicadoEm', i.created_at, 'convertidoEm', i.converted_at,
        'cupom', i.title, 'cupomCodigo', i.public_id, 'cupomStatus', i.coupon_status,
        'beneficioTipo', i.benefit_type, 'beneficioValor', i.benefit_value,
        'estabelecimento', i.business_name, 'cupomEm', i.issued_at,
        'resgatadoEm', i.validated_at, 'premioCodigo', i.reward_public_id)
      order by coalesce(i.validated_at, i.issued_at, i.created_at) desc
    ) filter (where i.id is not null), '[]'::jsonb)
  )
  from public.affiliates a
  left join indicacoes i on true
  where a.id = p_affiliate_id
    and a.tenant_id = p_tenant_id
    and a.phone_digits = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
  group by a.id;
$function$
;
-- -----------------------------------------------------------------------------
-- affiliate_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_kind text, p_referral_code text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_register(p_tenant_id uuid, p_name text, p_phone text, p_email text DEFAULT NULL::text, p_kind text DEFAULT 'customer'::text, p_referral_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_aff public.affiliates%rowtype;
  v_code text;
  v_base text;
begin
  -- Um telefone = um codigo, por digitos (nao por texto: "22 99833-6286" e
  -- "22 99833-6286 " sao o mesmo telefone). Se ja existe, devolve o cadastro.
  select * into v_aff
  from public.affiliates
  where tenant_id = p_tenant_id
    and phone_digits = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
    and phone_digits <> ''
  order by created_at
  limit 1;

  if found then
    return jsonb_build_object(
      'affiliateId', v_aff.id,
      'referralCode', v_aff.referral_code,
      'shareUrl', '/?ref=' || v_aff.referral_code,
      'alreadyRegistered', true
    );
  end if;

  -- codigo: usa o fornecido ou gera a partir do nome + aleatorio
  if p_referral_code is not null and p_referral_code <> '' then
    v_code := upper(regexp_replace(p_referral_code, '[^A-Za-z0-9]', '', 'g'));
  else
    v_base := upper(regexp_replace(coalesce(p_name, 'AFIL'), '[^A-Za-z0-9]', '', 'g'));
    v_base := left(v_base, 12);
    if v_base = '' then v_base := 'AFIL'; end if;
    v_code := v_base || '-' || upper(encode(gen_random_bytes(2), 'hex'));
  end if;

  insert into public.affiliates (tenant_id, name, phone, email, kind, referral_code)
  values (p_tenant_id, p_name, p_phone, p_email, p_kind, v_code)
  returning * into v_aff;

  return jsonb_build_object(
    'affiliateId', v_aff.id,
    'referralCode', v_aff.referral_code,
    'shareUrl', '/?ref=' || v_aff.referral_code,
    'alreadyRegistered', false
  );
exception
  when unique_violation then
    -- Colisao de CODIGO: e o caso normal, o codigo vem de nome + aleatorio.
    -- Qualquer outra violacao unica (telefone, numa corrida de dois cadastros
    -- ao mesmo tempo) nao se resolve mudando o codigo: devolve o existente.
    select * into v_aff
    from public.affiliates
    where tenant_id = p_tenant_id
      and phone_digits = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      and phone_digits <> ''
    order by created_at
    limit 1;

    if found then
      return jsonb_build_object(
        'affiliateId', v_aff.id,
        'referralCode', v_aff.referral_code,
        'shareUrl', '/?ref=' || v_aff.referral_code,
        'alreadyRegistered', true
      );
    end if;

    v_code := v_code || upper(encode(gen_random_bytes(1), 'hex'));
    insert into public.affiliates (tenant_id, name, phone, email, kind, referral_code)
    values (p_tenant_id, p_name, p_phone, p_email, p_kind, v_code)
    returning * into v_aff;
    return jsonb_build_object(
      'affiliateId', v_aff.id,
      'referralCode', v_aff.referral_code,
      'shareUrl', '/?ref=' || v_aff.referral_code,
      'alreadyRegistered', false
    );
end
$function$
;
-- -----------------------------------------------------------------------------
-- affiliate_reward_status(p_tenant_id uuid, p_affiliate_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_reward_status(p_tenant_id uuid, p_affiliate_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select jsonb_build_object(
    'affiliateId', a.id,
    'hasCustomer', (a.customer_id is not null),
    'customerId', a.customer_id,
    'rewardTemplateConfigured', (cfg.affiliate_reward_template_id is not null),
    'welcomeTemplateConfigured', (cfg.welcome_template_id is not null),
    'pendingReason', case
      when a.customer_id is null then 'semCadastroCliente'
      when cfg.affiliate_reward_template_id is null then 'semTemplate'
      else 'ok'
    end,
    'convertedCount', (
      select count(*) from public.referrals r
      where r.tenant_id = p_tenant_id and r.affiliate_id = a.id and r.status = 'converted'
    ),
    'rewardedCount', (
      select count(*) from public.referrals r
      where r.tenant_id = p_tenant_id and r.affiliate_id = a.id and r.reward_coupon_id is not null
    )
  )
  from public.affiliates a
  left join public.affiliate_rewards cfg on cfg.tenant_id = a.tenant_id
  where a.tenant_id = p_tenant_id
    and a.id = p_affiliate_id;
$function$
;
-- -----------------------------------------------------------------------------
-- auth_pin_reset_required(p_user_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_pin_reset_required(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT COALESCE(
    (SELECT must_change_pin FROM public.users WHERE id = p_user_id),
    false
  );
$function$
;
-- -----------------------------------------------------------------------------
-- auth_set_pin(p_tenant_id uuid, p_internal_code text, p_pin text) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_set_pin(p_tenant_id uuid, p_internal_code text, p_pin text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  update users set pin_hash = encode(digest(p_pin, 'sha256'), 'hex')
    where tenant_id = p_tenant_id and internal_code = p_internal_code;
end $function$
;
-- -----------------------------------------------------------------------------
-- billing_mp_cancel(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_cancel(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- billing_mp_prepare(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_prepare(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- billing_mp_register(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_subscription_id text, p_subscription_url text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_register(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_subscription_id text, p_subscription_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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

  UPDATE businesses
     SET billing_provider = 'mercadopago',
         billing_subscription_id = p_subscription_id,
         billing_subscription_url = p_subscription_url
   WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN RAISE EXCEPTION 'BUSINESS_NOT_FOUND'; END IF;
  RETURN true;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- billing_mp_webhook_charge(p_subscription_id text, p_payment_id text, p_amount_cents integer) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_webhook_charge(p_subscription_id text, p_payment_id text, p_amount_cents integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- billing_mp_webhook_preapproval(p_subscription_id text, p_status text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_mp_webhook_preapproval(p_subscription_id text, p_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- billing_record_coupon_tax(p_tenant_id uuid, p_template_id uuid, p_coupon_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_record_coupon_tax(p_tenant_id uuid, p_template_id uuid, p_coupon_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_business  businesses%rowtype;
  v_inserted  int;
BEGIN
  IF p_tenant_id IS NULL OR p_template_id IS NULL OR p_coupon_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT b.* INTO v_business
    FROM businesses b
    JOIN coupon_templates ct ON ct.business_id = b.id AND ct.tenant_id = b.tenant_id
   WHERE ct.id = p_template_id
     AND ct.tenant_id = p_tenant_id
   LIMIT 1;
  IF NOT found THEN RETURN false; END IF;

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
$function$
;
-- -----------------------------------------------------------------------------
-- business_coupon_stats(p_tenant_id uuid, p_business_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_coupon_stats(p_tenant_id uuid, p_business_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
  select jsonb_build_object(
    'totalIssued', (select count(*) from coupons where tenant_id=p_tenant_id and business_id=p_business_id),
    'totalValidated', (select count(*) from coupons where tenant_id=p_tenant_id and business_id=p_business_id and status='VALIDATED'),
    'totalAvailable', (select count(*) from coupons where tenant_id=p_tenant_id and business_id=p_business_id and status='AVAILABLE'),
    'totalExpired', (select count(*) from coupons where tenant_id=p_tenant_id and business_id=p_business_id and status='EXPIRED'),
    'totalBilledCents', (select coalesce(sum(amount_cents),0) from billing_charges where tenant_id=p_tenant_id and business_id=p_business_id)
  );
$function$
;
-- -----------------------------------------------------------------------------
-- business_delete_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_delete_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_deleted boolean := false;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  if exists (
    select 1 from public.shuttle_reservations r
    where r.shuttle_id = p_service_id
      and r.status in ('pending','confirmed')
  ) then
    raise exception 'SHUTTLE_HAS_RESERVATIONS';
  end if;

  delete from public.shuttle_services
  where id = p_service_id
    and tenant_id = p_tenant_id
    and business_id = v_actor.business_id
  returning true into v_deleted;

  if v_deleted is not true then
    raise exception 'FORBIDDEN';
  end if;
  return v_deleted;
end $function$
;
-- -----------------------------------------------------------------------------
-- business_delete_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_delete_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_owned text;
  v_count int;
  v_used int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- Invalida os cupons que ainda não foram usados (mantém o histórico).
  UPDATE public.coupons
  SET status = 'CANCELLED'
  WHERE template_id = p_template_id
    AND tenant_id = p_tenant_id
    AND status IN ('AVAILABLE', 'EXPIRED');

  DELETE FROM public.coupon_templates
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- business_get_own(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype; v_business businesses%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.business_id is null then raise exception 'FORBIDDEN'; end if;
  select * into v_business from businesses where id=v_actor.business_id;
  return jsonb_build_object('name',v_business.name,'phone',v_business.phone,'email',v_business.email,
    'city',v_business.city,'category',v_business.category,'cnpj',v_business.cnpj,'website',v_business.website,
    'instagram',v_business.instagram,
    'logoUrl',v_business.logo_url,
    'lat', case when v_business.location is not null then ST_Y(v_business.location::geometry) else null end,
    'lng', case when v_business.location is not null then ST_X(v_business.location::geometry) else null end);
end $function$
;
-- -----------------------------------------------------------------------------
-- business_list_shuttle_reservations(p_tenant_id uuid, p_actor_user_id uuid, p_status text, p_date date) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_list_shuttle_reservations(p_tenant_id uuid, p_actor_user_id uuid, p_status text DEFAULT NULL::text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tz         constant text := 'America/Sao_Paulo';
  v_actor      public.users%rowtype;
begin
  select * into v_actor
    from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'businessName',    b.name,
        'businessPhone',   b.phone,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        'priceCents',      r.price_cents,
        'status',          r.status,
        'contactPhone',    r.contact_phone,
        'notes',           r.notes,
        'reason',          r.reason,
        'createdAt',       r.created_at,
        'decidedAt',       r.decided_at
      ) order by r.scheduled_for asc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    join public.businesses b on b.id = r.business_id
    where r.tenant_id = p_tenant_id
      and (v_actor.role = 'SUPER_ADMIN' or r.business_id = v_actor.business_id)
      and (p_status is null or r.status = p_status)
      and (p_date is null or (r.scheduled_for at time zone v_tz)::date = p_date)
  ), '[]'::jsonb);
end
$function$
;
-- -----------------------------------------------------------------------------
-- business_list_shuttle_services(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_list_shuttle_services(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'shuttleId', s.id,
        'name', s.name,
        'description', s.description,
        'serviceType', s.service_type,
        'origin', jsonb_build_object(
          'lat', ST_Y(s.origin::geometry), 'lng', ST_X(s.origin::geometry)),
        'destination', jsonb_build_object(
          'lat', ST_Y(s.destination::geometry), 'lng', ST_X(s.destination::geometry)),
        'stops', s.stops,
        'priceCents', s.price_cents,
        'opensAt', s.opens_at,
        'closesAt', s.closes_at,
        'activeDays', s.active_days,
        'isActive', s.is_active,
        'createdAt', s.created_at,
        'updatedAt', s.updated_at
      ) order by s.created_at desc
    )
    from public.shuttle_services s
    where s.tenant_id = p_tenant_id
      and s.business_id = v_actor.business_id
  ), '[]'::jsonb);
end $function$
;
-- -----------------------------------------------------------------------------
-- business_logo_by_id(p_business_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_logo_by_id(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_logo text; v_name text;
begin
  select b.logo_url, b.name into v_logo, v_name
  from businesses b where b.id = p_business_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object('businessId', p_business_id, 'name', v_name, 'logoUrl', v_logo);
end $function$
;
-- -----------------------------------------------------------------------------
-- business_public_card(p_business_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_public_card(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row businesses%rowtype;
begin
  select * into v_row from businesses b where b.id = p_business_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'businessId', p_business_id,
    'name', v_row.name,
    'logoUrl', v_row.logo_url,
    'phone', v_row.phone,
    'email', v_row.email,
    'website', v_row.website,
    'instagram', v_row.instagram,
    'category', v_row.category,
    'city', v_row.city
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- business_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_de   timestamptz;
  v_ate  timestamptz;
begin
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  -- Admin/Dono: pode ver o tenant inteiro (mesma logica do business_get_own)
  if not found then
    raise exception 'FORBIDDEN';
  end if;

  if v_actor.role not in ('MERCHANT', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN: apenas empresa ou admin ve o relatorio';
  end if;

  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),

    'totals', (
      select jsonb_build_object(
        'issued',        count(*),
        'validated',     count(*) filter (where c.validated_at is not null),
        'available',     count(*) filter (where c.validated_at is null),
        'conversionPct', case when count(*) = 0 then 0
                              else round(100.0 * count(*) filter (where c.validated_at is not null) / count(*), 1)
                             end,
        -- Clientes ATRIBUIVEIS a esta empresa: os que resgataram cupom
        -- dela no periodo. Clientes nao tem business_id, entao a unica
        -- atribuicao confiavel e via cupom. "first_seen" = primeira vez
        -- que este cliente apareceu na empresa (nao re-conta se ja era
        -- cliente antes no periodo).
        'newCustomers',  (
          select count(*) from (
            select c2.customer_id
            from coupons c2
            where c2.tenant_id = p_tenant_id
              and c2.business_id = v_actor.business_id
              and c2.customer_id is not null
              and c2.issued_at >= v_de and c2.issued_at <= v_ate
            group by c2.customer_id
            having min(c2.issued_at) >= v_de
          ) nc
        ),
        -- Total de clientes unicos que ja resgataram desta empresa (nao
        -- limitado ao periodo) - usado como denominador de fidelizacao.
        'totalCustomers', (
          select count(distinct c3.customer_id)
          from coupons c3
          where c3.tenant_id = p_tenant_id
            and c3.business_id = v_actor.business_id
            and c3.customer_id is not null
        ),
        -- Quantos desses clientes voltaram (resgataram 2+ vezes)
        'returningCustomers', (
          select count(*) from (
            select c4.customer_id
            from coupons c4
            where c4.tenant_id = p_tenant_id
              and c4.business_id = v_actor.business_id
              and c4.customer_id is not null
            group by c4.customer_id
            having count(*) > 1
          ) rc
        )
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.business_id = v_actor.business_id
        and c.issued_at  >= v_de
        and c.issued_at  <= v_ate
    ),

    -- ---------------- serie diaria (grafico) ----------------
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object('day', d.dia, 'issued', d.emitidos, 'validated', d.validados)
        order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at)::date as dia,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) d
    ),

    -- ---------------- quebra por campanha ----------------
    'byCampaign', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'campaignId', g.campanha_id,
          'title',      coalesce(camp.title, 'Sem campanha'),
          'issued',     g.emitidos,
          'validated',  g.validados
        ) order by g.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.campaign_id as campanha_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) g
      left join campaigns camp on camp.id = g.campanha_id
    ),

    -- ---------------- quebra por cupom ----------------
    'byTemplate', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'templateId', t.template_id,
          'title',      coalesce(ct.title, 'Sem cupom'),
          'issued',     t.emitidos,
          'validated',  t.validados
        ) order by t.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.template_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) t
      join coupon_templates ct on ct.id = t.template_id
    )
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- business_report_v3(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_report_v3(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor    users%rowtype;
  v_business businesses%rowtype;
  v_de       timestamptz;
  v_ate      timestamptz;
begin
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'FORBIDDEN: ator nao pertence a este tenant';
  end if;

  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN: papel sem acesso ao relatorio';
  end if;

  if v_actor.business_id is null then
    raise exception 'BUSINESS_NOT_FOUND: ator nao vinculado a um negocio';
  end if;

  select * into v_business
  from businesses
  where id = v_actor.business_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'BUSINESS_NOT_FOUND: negocio do ator nao existe neste tenant';
  end if;

  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),
    'totals', (
      select jsonb_build_object(
        'issued',        count(*),
        'validated',     count(*) filter (where c.validated_at is not null),
        'available',     count(*) filter (where c.validated_at is null),
        'conversionPct', case when count(*) = 0 then 0
                              else round(100.0 * count(*) filter (where c.validated_at is not null) / count(*), 1)
                             end,
        'newCustomers',  (
          select count(*) from (
            select c2.customer_id
            from coupons c2
            where c2.tenant_id = p_tenant_id
              and c2.business_id = v_business.id
              and c2.customer_id is not null
              and c2.issued_at >= v_de and c2.issued_at <= v_ate
            group by c2.customer_id
            having min(c2.issued_at) >= v_de
          ) nc
        ),
        'totalCustomers', (
          select count(distinct c3.customer_id)
          from coupons c3
          where c3.tenant_id = p_tenant_id
            and c3.business_id = v_business.id
            and c3.customer_id is not null
        ),
        'returningCustomers', (
          select count(*) from (
            select c4.customer_id
            from coupons c4
            where c4.tenant_id = p_tenant_id
              and c4.business_id = v_business.id
              and c4.customer_id is not null
            group by c4.customer_id
            having count(*) > 1
          ) rc
        )
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.business_id = v_business.id
        and c.issued_at  >= v_de
        and c.issued_at  <= v_ate
    ),
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object('day', d.dia, 'issued', d.emitidos, 'validated', d.validados)
        order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at)::date as dia,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) d
    ),
    'byCampaign', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'campaignId', g.campanha_id,
          'title',      coalesce(camp.title, 'Sem campanha'),
          'issued',     g.emitidos,
          'validated',  g.validados
        ) order by g.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.campaign_id as campanha_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) g
      left join campaigns camp on camp.id = g.campanha_id
    ),
    'byTemplate', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'templateId', t.template_id,
          'title',      coalesce(ct.title, 'Sem cupom'),
          'issued',     t.emitidos,
          'validated',  t.validados
        ) order by t.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.template_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_business.id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) t
      join coupon_templates ct on ct.id = t.template_id
    ),
    'drivers', (
      select jsonb_build_object(
        'total',    count(*),
        'approved', count(*) filter (where d.status = 'approved'),
        'pending',  count(*) filter (where d.status = 'pending'),
        'rejected', count(*) filter (where d.status = 'rejected'),
        'documentsPending', (
          select count(*)
          from driver_documents dd
          where dd.tenant_id = p_tenant_id
            and dd.status = 'pending'
            and dd.driver_id in (
              select d2.id from drivers d2
              where d2.tenant_id = p_tenant_id
                and (
                  v_actor.role = 'SUPER_ADMIN'
                  or d2.business_id is null
                  or d2.business_id = v_business.id
                )
            )
        )
      )
      from drivers d
      where d.tenant_id = p_tenant_id
        and (
          v_actor.role = 'SUPER_ADMIN'
          or d.business_id is null
          or d.business_id = v_business.id
        )
    ),
    'billing', (
      select jsonb_build_object(
        'plan',              v_business.billing_plan,
        'status',            v_business.billing_status,
        'monthlyFeeCents',   v_business.monthly_fee_cents,
        'feePerCouponCents', v_business.billing_fee_cents,
        'chargedCents', coalesce((
          select sum(bc.amount_cents) from billing_charges bc
          where bc.tenant_id = p_tenant_id
            and bc.business_id = v_business.id
            and bc.created_at >= v_de
            and bc.created_at <= v_ate
        ), 0),
        'charges', coalesce((
          select count(*) from billing_charges bc
          where bc.tenant_id = p_tenant_id
            and bc.business_id = v_business.id
            and bc.created_at >= v_de
            and bc.created_at <= v_ate
        ), 0)
      )
    ),
    'shuttle', (
      select jsonb_build_object(
        'services', (
          select count(*) from shuttle_services s
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
        ),
        'activeServices', (
          select count(*) from shuttle_services s
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
            and s.is_active
        ),
        'vehiclesReporting', (
          select count(*)
          from vehicle_positions vp
          join shuttle_services s on s.id = vp.shuttle_id
          where s.tenant_id = p_tenant_id
            and s.business_id = v_business.id
            and vp.recorded_at > now() - interval '5 minutes'
        )
      )
    ),
    'rides', null
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- business_review_shuttle_reservation(p_tenant_id uuid, p_actor_user_id uuid, p_reservation_id uuid, p_action text, p_reason text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_review_shuttle_reservation(p_tenant_id uuid, p_actor_user_id uuid, p_reservation_id uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor  public.users%rowtype;
  v_res    public.shuttle_reservations%rowtype;
  v_next   text;
begin
  select * into v_actor
    from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  if p_action is null or p_action not in ('confirm','reject','cancel') then
    raise exception 'ACTION_INVALID';
  end if;

  select * into v_res
    from public.shuttle_reservations
    where id = p_reservation_id
      and tenant_id = p_tenant_id
      and (v_actor.role = 'SUPER_ADMIN' or business_id = v_actor.business_id)
    for update;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  v_next := case p_action
              when 'confirm' then 'confirmed'
              when 'reject'  then 'rejected'
              else 'cancelled'
            end;

  if not (
       (v_res.status = 'pending'  and v_next in ('confirmed','rejected','cancelled'))
    or (v_res.status = 'confirmed' and v_next = 'cancelled')
  ) then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  if v_next = 'rejected' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;

  update public.shuttle_reservations
    set status = v_next,
        reason = nullif(btrim(coalesce(p_reason, '')), ''),
        decided_by = p_actor_user_id,
        decided_at = now(),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', v_next
  );
end
$function$
;
-- -----------------------------------------------------------------------------
-- business_save_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_name text, p_description text, p_service_type text, p_origin_lat double precision, p_origin_lng double precision, p_dest_lat double precision, p_dest_lng double precision, p_stops jsonb, p_price_cents integer, p_opens_at time without time zone, p_closes_at time without time zone, p_active_days smallint[], p_duration_minutes integer) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_save_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_service_type text DEFAULT 'shuttle'::text, p_origin_lat double precision DEFAULT NULL::double precision, p_origin_lng double precision DEFAULT NULL::double precision, p_dest_lat double precision DEFAULT NULL::double precision, p_dest_lng double precision DEFAULT NULL::double precision, p_stops jsonb DEFAULT '[]'::jsonb, p_price_cents integer DEFAULT NULL::integer, p_opens_at time without time zone DEFAULT NULL::time without time zone, p_closes_at time without time zone DEFAULT NULL::time without time zone, p_active_days smallint[] DEFAULT NULL::smallint[], p_duration_minutes integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_geo geography;
  v_id uuid;
  v_days smallint[] := coalesce(p_active_days, '{0,1,2,3,4,5,6}'::smallint[]);
  v_day smallint;
  v_duration integer;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_service_type is null or p_service_type not in ('shuttle','transfer','tour') then
    raise exception 'INVALID_TYPE';
  end if;
  if p_origin_lat is null or p_origin_lng is null
     or p_origin_lat < -90 or p_origin_lat > 90
     or p_origin_lng < -180 or p_origin_lng > 180
     or p_dest_lat is null or p_dest_lng is null
     or p_dest_lat < -90 or p_dest_lat > 90
     or p_dest_lng < -180 or p_dest_lng > 180 then
    raise exception 'INVALID_COORDS';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'INVALID_STOPS';
  end if;
  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_opens_at is not null and p_closes_at is not null and p_closes_at < p_opens_at then
    raise exception 'INVALID_HOURS';
  end if;

  if p_active_days is not null then
    if array_length(p_active_days, 1) = 0 then
      v_days := '{0,1,2,3,4,5,6}'::smallint[];
    else
      foreach v_day in array p_active_days loop
        if v_day is null or v_day < 0 or v_day > 6 then
          raise exception 'INVALID_DAYS';
        end if;
      end loop;
      if (select count(distinct d) = count(*) from unnest(p_active_days) d) is false then
        raise exception 'INVALID_DAYS';
      end if;
      v_days := p_active_days;
    end if;
  end if;

  if p_duration_minutes is not null then
    if p_duration_minutes < 15 or p_duration_minutes > 720 then
      raise exception 'INVALID_DURATION';
    end if;
    v_duration := p_duration_minutes;
  end if;

  if p_service_id is null then
    insert into public.shuttle_services (
      tenant_id, business_id, name, description, service_type,
      origin, destination, stops, price_cents, opens_at, closes_at,
      active_days, duration_minutes
    ) values (
      p_tenant_id, v_actor.business_id, btrim(p_name), p_description, p_service_type,
      ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      p_stops, p_price_cents, p_opens_at, p_closes_at, v_days,
      coalesce(v_duration, 60)
    )
    returning id into v_id;
  else
    if not exists (
      select 1 from public.shuttle_services s
      where s.id = p_service_id
        and s.tenant_id = p_tenant_id
        and s.business_id = v_actor.business_id
    ) then
      raise exception 'FORBIDDEN';
    end if;
    update public.shuttle_services set
      name = btrim(p_name),
      description = p_description,
      service_type = p_service_type,
      origin = ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      destination = ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      stops = p_stops,
      price_cents = p_price_cents,
      opens_at = p_opens_at,
      closes_at = p_closes_at,
      active_days = v_days,
      duration_minutes = coalesce(v_duration, duration_minutes),
      updated_at = now()
    where id = p_service_id
    returning id into v_id;
  end if;

  return jsonb_build_object('shuttleId', v_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- business_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.coupon_templates t
    where t.id = p_template_id
      and t.tenant_id = p_tenant_id
      and t.business_id = v_actor.business_id
  ) then
    raise exception 'FORBIDDEN';
  end if;
  update public.coupon_templates
    set featured_until = p_until
    where id = p_template_id and tenant_id = p_tenant_id;
end $function$
;
-- -----------------------------------------------------------------------------
-- business_set_pin(p_tenant_id uuid, p_actor_user_id uuid, p_new_pin text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_set_pin(p_tenant_id uuid, p_actor_user_id uuid, p_new_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;
-- -----------------------------------------------------------------------------
-- business_toggle_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_is_active boolean) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_toggle_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_is_active boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_changed boolean := false;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  update public.shuttle_services set
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_service_id
    and tenant_id = p_tenant_id
    and business_id = v_actor.business_id
  returning true into v_changed;

  if v_changed is not true then
    raise exception 'FORBIDDEN';
  end if;
  return v_changed;
end $function$
;
-- -----------------------------------------------------------------------------
-- business_toggle_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_is_active boolean) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_toggle_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_is_active boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_owned text;
  v_count int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE public.coupon_templates
  SET is_active = p_is_active
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- business_update_own(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_phone text, p_email text, p_city text, p_logo_url text, p_category text, p_lat double precision, p_lng double precision, p_website text, p_instagram text) RETURNS void
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_update_own(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_phone text, p_email text, p_city text, p_logo_url text, p_category text DEFAULT NULL::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_website text DEFAULT NULL::text, p_instagram text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;
  update public.businesses set
    name = coalesce(p_name, name),
    phone = coalesce(p_phone, phone),
    email = coalesce(p_email, email),
    city = coalesce(p_city, city),
    logo_url = coalesce(p_logo_url, logo_url),
    category = coalesce(p_category, category),
    website = case when p_website is null then website else nullif(btrim(p_website), '') end,
    instagram = case when p_instagram is null then instagram else public.normalize_instagram(p_instagram) end,
    location = case when p_lat is not null and p_lng is not null
                    then st_makepoint(p_lng, p_lat)::geography
                    else location end
  where id = v_actor.business_id and tenant_id = p_tenant_id;
end $function$
;
-- -----------------------------------------------------------------------------
-- business_update_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_update_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_owned text;
  v_count int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_title IS NULL OR length(p_title) < 2 THEN
    RAISE EXCEPTION 'TITLE_TOO_SHORT';
  END IF;
  IF p_benefit_value IS NULL OR p_benefit_value <= 0 THEN
    RAISE EXCEPTION 'BENEFIT_VALUE_INVALID';
  END IF;

  UPDATE public.coupon_templates
  SET title = p_title,
      benefit_type = p_benefit_type,
      benefit_value = p_benefit_value,
      total_stock = p_total_stock,
      image_url = p_image_url
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- create_campaign(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_title text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_campaign(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_title text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype; v_id uuid;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('MERCHANT','MANAGER','ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  insert into campaigns (tenant_id, business_id, title, status, rules, created_by_user_id)
    values (p_tenant_id, p_business_id, p_title, 'PUBLISHED', '{}'::jsonb, p_actor_user_id) returning id into v_id;
  return jsonb_build_object('campaignId', v_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- create_coupon_template(p_tenant_id uuid, p_business_id uuid, p_campaign_id uuid, p_actor_user_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_coupon_template(p_tenant_id uuid, p_business_id uuid, p_campaign_id uuid, p_actor_user_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor users%rowtype; v_id uuid;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('MERCHANT','MANAGER','ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  insert into coupon_templates (tenant_id, business_id, campaign_id, title, benefit_type, benefit_value, design, total_stock, per_customer_limit, image_url)
    values (p_tenant_id, p_business_id, p_campaign_id, p_title, p_benefit_type, p_benefit_value, '{"layoutSchemaVersion":"1","fields":{}}'::jsonb, p_total_stock, 3, p_image_url) returning id into v_id;
  return jsonb_build_object('templateId', v_id);
end $function$
;
-- -----------------------------------------------------------------------------
-- digits_only(p_raw text) RETURNS text
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.digits_only(p_raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_temp'
AS $function$
  select regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g');
$function$
;
-- -----------------------------------------------------------------------------
-- driver_get_document_path(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_get_document_path(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor  users%rowtype;
  v_doc    driver_documents%rowtype;
  v_driver drivers%rowtype;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_document_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  select * into v_actor from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;

  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_doc from driver_documents
  where id = p_document_id and tenant_id = p_tenant_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_driver from drivers
  where id = v_doc.driver_id and tenant_id = p_tenant_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  if v_actor.role <> 'SUPER_ADMIN'
     and v_driver.business_id is not null
     and v_driver.business_id <> v_actor.business_id then
    raise exception 'FORBIDDEN';
  end if;

  return jsonb_build_object(
    'documentId', v_doc.id,
    'docType',    v_doc.doc_type,
    'status',     v_doc.status,
    'docNumber',  v_doc.doc_number,
    'driverId',   v_driver.id,
    'driverName', v_driver.name,
    'docPath',    v_doc.doc_url
  );
end;
$function$
;
-- -----------------------------------------------------------------------------
-- driver_list_for_business(p_tenant_id uuid, p_actor_user_id uuid, p_status text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_list_for_business(p_tenant_id uuid, p_actor_user_id uuid, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'driverId', d.id,
      'name', d.name,
      'phone', d.phone,
      'email', d.email,
      'cpf', d.cpf,
      'cnpj', d.cnpj,
      'legalName', d.legal_name,
      'status', d.status,
      'businessId', d.business_id,
      'createdAt', d.created_at,
      'approvedAt', d.approved_at,
      'documents', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', dd.id,
          'docType', dd.doc_type,
          'status', dd.status,
          'reviewedAt', dd.reviewed_at
        ) order by dd.created_at), '[]'::jsonb)
        from driver_documents dd where dd.driver_id = d.id
      )
    ) order by d.created_at desc)
    from drivers d
    where d.tenant_id = p_tenant_id
      and (p_status is null or d.status = p_status)
      and (
        v_actor.role = 'SUPER_ADMIN'
        or d.business_id is null
        or d.business_id = v_actor.business_id
      )
  ), '[]'::jsonb);
end $function$
;
-- -----------------------------------------------------------------------------
-- driver_review_document(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid, p_action text, p_reason text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_review_document(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_doc driver_documents%rowtype;
  v_driver drivers%rowtype;
  v_pendentes int;
begin
  if p_action not in ('approve','reject') then raise exception 'ACTION_INVALID'; end if;

  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role <> 'SUPER_ADMIN'
     and (v_actor.business_id is null or v_actor.role not in ('MERCHANT','ADMIN','STAFF')) then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_doc from driver_documents where id = p_document_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND'; end if;

  select * into v_driver from drivers where id = v_doc.driver_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- empresa so pode revisar motorista do proprio negocio (ou sem empresa)
  if v_actor.role <> 'SUPER_ADMIN' and v_driver.business_id is not null
     and v_actor.business_id <> v_driver.business_id then
    raise exception 'FORBIDDEN: motorista de outra empresa';
  end if;

  -- a revisao muda o status e registra quem revisou; nao altera o numero
  -- nem a URL que o motorista enviou. p_reason guarda o motivo da
  -- reprovacao, que e o que a empresa precisa explicar ao motorista.
  update driver_documents
  set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
      reviewed_by = p_actor_user_id,
      reviewed_at = now(),
      review_note = case
        when p_action = 'reject' then nullif(trim(coalesce(p_reason, '')), '')
        else review_note
      end
  where id = p_document_id;

  -- conta documentos pendentes deste motorista
  select count(*) into v_pendentes
  from driver_documents
  where driver_id = v_driver.id and status = 'pending';

  -- se reprovou qualquer documento, o cadastro vai para 'rejected'
  if exists (select 1 from driver_documents where driver_id = v_driver.id and status = 'rejected') then
    update drivers set status = 'rejected', approved_at = null, updated_at = now() where id = v_driver.id;
  -- se nao ha mais pendencia e ha ao menos um aprovado, habilita
  elsif v_pendentes = 0
        and exists (select 1 from driver_documents where driver_id = v_driver.id and status = 'approved') then
    update drivers set status = 'approved', approved_at = coalesce(approved_at, now()), updated_at = now() where id = v_driver.id;
  end if;

  return jsonb_build_object(
    'documentId', p_document_id,
    'documentStatus', case when p_action = 'approve' then 'approved' else 'rejected' end,
    'driverStatus', (select status from drivers where id = v_driver.id)
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- identify_customer(p_tenant_id uuid, p_phone text, p_name text, p_email text, p_instagram text) RETURNS uuid
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.identify_customer(p_tenant_id uuid, p_phone text, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_instagram text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_id uuid;
begin
  select id into v_id from users where tenant_id=p_tenant_id and internal_code=p_phone;
  if not found then
    insert into users (tenant_id, internal_code, role, phone, name, email, instagram)
      values (p_tenant_id, p_phone, 'CUSTOMER', p_phone, p_name, p_email, p_instagram) returning id into v_id;
  else
    update users set name=coalesce(p_name,name), email=coalesce(p_email,email), instagram=coalesce(p_instagram,instagram) where id=v_id;
  end if;
  return v_id;
end $function$
;
-- -----------------------------------------------------------------------------
-- is_valid_cnpj(p_cnpj text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_cnpj(p_cnpj text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_temp'
AS $function$
declare
  v  text := public.digits_only(p_cnpj);
  i  integer;
  s  integer := 0;
  d1 integer;
  d2 integer;
begin
  if length(v) <> 14 then
    return false;
  end if;
  if v ~ '^(.)\1{13}$' then
    return false;
  end if;

  s := 0;
  for i in 1..12 loop
    s := s + (substr(v, i, 1))::integer *
      (case i when 1 then 5 when 2 then 4 when 3 then 3 when 4 then 2
              when 5 then 9 when 6 then 8 when 7 then 7 when 8 then 6
              when 9 then 5 when 10 then 4 when 11 then 3 else 2 end);
  end loop;
  d1 := 11 - mod(s, 11);
  if d1 >= 10 then d1 := 0; end if;

  if (substr(v, 13, 1))::integer <> d1 then
    return false;
  end if;

  s := 0;
  for i in 1..13 loop
    s := s + (substr(v, i, 1))::integer *
      (case i when 1 then 6 when 2 then 5 when 3 then 4 when 4 then 3 when 5 then 2
              when 6 then 9 when 7 then 8 when 8 then 7 when 9 then 6 when 10 then 5
              when 11 then 4 when 12 then 3 else 2 end);
  end loop;
  d2 := 11 - mod(s, 11);
  if d2 >= 10 then d2 := 0; end if;

  return (substr(v, 14, 1))::integer = d2;
end;
$function$
;
-- -----------------------------------------------------------------------------
-- is_valid_cpf(p_cpf text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_cpf(p_cpf text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_temp'
AS $function$
declare
  v  text := public.digits_only(p_cpf);
  i  integer;
  s  integer := 0;
  d1 integer;
  d2 integer;
begin
  if length(v) <> 11 then
    return false;
  end if;
  if v ~ '^(.)\1{10}$' then
    return false;
  end if;

  for i in 1..9 loop
    s := s + (substr(v, i, 1))::integer * (11 - i);
  end loop;
  d1 := mod(s * 10, 11);
  if d1 = 10 then d1 := 0; end if;

  if (substr(v, 10, 1))::integer <> d1 then
    return false;
  end if;

  s := 0;
  for i in 1..10 loop
    s := s + (substr(v, i, 1))::integer * (12 - i);
  end loop;
  d2 := mod(s * 10, 11);
  if d2 = 10 then d2 := 0; end if;

  return (substr(v, 11, 1))::integer = d2;
end;
$function$
;
-- -----------------------------------------------------------------------------
-- link_affiliate_by_id(p_tenant_id uuid, p_affiliate_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_affiliate_by_id(p_tenant_id uuid, p_affiliate_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_linked integer := 0;
begin
  if p_tenant_id is null or p_affiliate_id is null then
    return false;
  end if;

  update public.affiliates a
  set customer_id = u.id
  from public.users u
  where a.tenant_id = p_tenant_id
    and a.id = p_affiliate_id
    and a.customer_id is null
    and u.tenant_id = p_tenant_id
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') = a.phone_digits
    and regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') <> '';
  get diagnostics v_linked = row_count;
  return (v_linked > 0);

exception
  when others then
    return false;
end $function$
;
-- -----------------------------------------------------------------------------
-- link_affiliate_customer(p_tenant_id uuid, p_customer_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_affiliate_customer(p_tenant_id uuid, p_customer_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_digitos text;
  v_linked integer;
begin
  if p_tenant_id is null or p_customer_id is null then
    return false;
  end if;

  select regexp_replace(coalesce(u.phone, ''), '\D', '', 'g')
  into v_digitos
  from public.users u
  where u.id = p_customer_id
    and u.tenant_id = p_tenant_id;

  -- Cliente sem telefone utilizavel: nao ha com o que casar.
  if v_digitos is null or v_digitos = '' then
    return false;
  end if;

  update public.affiliates a
  set customer_id = p_customer_id
  where a.tenant_id = p_tenant_id
    and a.phone_digits = v_digitos
    and a.customer_id is null;

  get diagnostics v_linked = row_count;
  return (v_linked > 0);

exception
  when others then
    -- NUNCA propaga erro. Este vinculo e um extra; o cadastro do
    -- cliente ja aconteceu antes desta chamada e nao pode falhar
    -- por causa dela.
    return false;
end $function$
;
-- -----------------------------------------------------------------------------
-- list_customer_coupons(p_tenant_id uuid, p_customer_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_customer_coupons(p_tenant_id uuid, p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'publicId', co.public_id,
    'status', co.status,
    'issuedAt', co.issued_at,
    'expiresAt', co.expires_at,
    'validatedAt', co.validated_at,
    'title', t.title,
    'businessId', b.id,
    'businessName', b.name,
    'businessLogoUrl', b.logo_url,
    'businessPhone', b.phone,
    'businessWebsite', b.website,
    'businessInstagram', b.instagram
  ) order by co.issued_at desc), '[]'::jsonb)
  from coupons co
  join coupon_templates t on t.id = co.template_id
  join businesses b on b.id = co.business_id
  where co.tenant_id = p_tenant_id and co.customer_id = p_customer_id;
$function$
;
-- -----------------------------------------------------------------------------
-- list_live_vehicles(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_m double precision, p_max_age_s integer) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_live_vehicles(p_tenant_id uuid, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_m double precision DEFAULT NULL::double precision, p_max_age_s integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'driverId', v.driver_id,
      'driverName', d.name,
      'shuttleId', v.shuttle_id,
      'lat', v.lat,
      'lng', v.lng,
      'heading', v.heading,
      'speedKmh', v.speed_kmh,
      'accuracyM', v.accuracy_m,
      'recordedAt', v.recorded_at,
      'distanceKm', case when p_lat is not null
        then round((ST_Distance(
              ST_MakePoint(v.lng, v.lat)::geography,
              ST_MakePoint(p_lng, p_lat)::geography
            ) / 1000)::numeric, 2)
        else null end
    ) order by v.recorded_at desc
  ), '[]'::jsonb)
  from vehicle_positions v
  join drivers d on d.id = v.driver_id and d.status = 'approved'
  where v.tenant_id = p_tenant_id
    and v.recorded_at > now() - make_interval(secs => p_max_age_s)
    and (p_lat is null or p_radius_m is null
         or ST_DWithin(
              ST_MakePoint(v.lng, v.lat)::geography,
              ST_MakePoint(p_lng, p_lat)::geography,
              p_radius_m));
$function$
;
-- -----------------------------------------------------------------------------
-- list_shuttle_services(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_shuttle_services(p_tenant_id uuid, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'shuttleId', s.id,
      'name', s.name,
      'description', s.description,
      'serviceType', s.service_type,
      'businessId', s.business_id,
      'businessName', b.name,
      'businessLogoUrl', b.logo_url,
      'priceCents', s.price_cents,
      'opensAt', s.opens_at,
      'closesAt', s.closes_at,
      'activeDays', s.active_days,
      'origin', case when s.origin is not null then
        jsonb_build_object('lat', ST_Y(s.origin::geometry), 'lng', ST_X(s.origin::geometry))
        else null end,
      'destination', case when s.destination is not null then
        jsonb_build_object('lat', ST_Y(s.destination::geometry), 'lng', ST_X(s.destination::geometry))
        else null end,
      'stops', s.stops,
      -- Distancia do cliente ate a origem (quando p_lat/p_lng enviados)
      'distanceKm', case when p_lat is not null and s.origin is not null
        then round((ST_Distance(s.origin, ST_MakePoint(p_lng, p_lat)::geography) / 1000)::numeric, 2)
        else null end
    ) order by
      case when p_lat is not null and s.origin is not null
        then ST_Distance(s.origin, ST_MakePoint(p_lng, p_lat)::geography) else null end asc nulls last,
      s.name asc
  ), '[]'::jsonb)
  from shuttle_services s
  join businesses b on b.id = s.business_id and b.is_active
  where s.tenant_id = p_tenant_id
    and s.is_active
    and (p_lat is null or p_radius_km is null
         or ST_DWithin(s.origin, ST_MakePoint(p_lng, p_lat)::geography, p_radius_km * 1000));
$function$
;
-- -----------------------------------------------------------------------------
-- norm_categoria(p text) RETURNS text
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.norm_categoria(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select translate(lower(coalesce(p, '')), 'áàâãäåéèêëíìîïóòôõöúùûüç', 'aaaaaaeeeeiiiiooooouuuuc');
$function$
;
-- -----------------------------------------------------------------------------
-- normalize_instagram(p_handle text) RETURNS text
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_instagram(p_handle text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_temp'
AS $function$
  select nullif(
    lower(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(btrim(coalesce(p_handle, '')), '^((https?://)?(www\.)?instagram\.com/?)', '', 'i'),
            '^@+', ''
          ),
          '/+$', ''
        )
      )
    ),
    ''
  );
$function$
;
-- -----------------------------------------------------------------------------
-- outbound_enqueue(p_tenant_id uuid, p_event text, p_channel text, p_destination text, p_subject text, p_body text, p_customer_id uuid, p_coupon_id uuid, p_booking_ref text, p_provider text, p_status text, p_strict boolean) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outbound_enqueue(p_tenant_id uuid, p_event text, p_channel text, p_destination text DEFAULT NULL::text, p_subject text DEFAULT NULL::text, p_body text DEFAULT NULL::text, p_customer_id uuid DEFAULT NULL::uuid, p_coupon_id uuid DEFAULT NULL::uuid, p_booking_ref text DEFAULT NULL::text, p_provider text DEFAULT 'none'::text, p_status text DEFAULT 'noop'::text, p_strict boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_id       uuid;
  v_event    text := trim(coalesce(p_event, ''));
  v_channel  text := upper(trim(coalesce(p_channel, '')));
  v_provider text := lower(trim(coalesce(p_provider, 'none')));
  v_status   text := lower(trim(coalesce(p_status, 'noop')));
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'OUTBOUND_FORBIDDEN: tenant ausente';
  END IF;
  IF v_event = '' THEN
    RAISE EXCEPTION 'OUTBOUND_EVENT_INVALID: evento ausente';
  END IF;
  IF v_channel NOT IN ('WHATSAPP', 'EMAIL') THEN
    RAISE EXCEPTION 'OUTBOUND_CHANNEL_INVALID: %', v_channel;
  END IF;
  IF v_provider NOT IN ('none', 'whatsapp_cloud_api', 'smtp') THEN v_provider := 'none'; END IF;
  IF v_status   NOT IN ('noop', 'queued', 'sent', 'failed')  THEN v_status   := 'noop'; END IF;

  INSERT INTO outbound_messages (
    tenant_id, customer_id, event, channel, provider, destination,
    subject, body, status, coupon_id, booking_ref
  )
  VALUES (
    p_tenant_id, p_customer_id, v_event, v_channel, v_provider,
    nullif(trim(coalesce(p_destination, '')), ''),
    p_subject, p_body, v_status, p_coupon_id,
    nullif(trim(coalesce(p_booking_ref, '')), '')
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    IF coalesce(p_strict, false) THEN
      RAISE EXCEPTION 'OUTBOUND_DUPLICATE: aviso ja registrado para este evento/canal';
    END IF;
    RETURN jsonb_build_object('inserted', false, 'id', null);
  END IF;

  RETURN jsonb_build_object('inserted', true, 'id', v_id);
END;
$function$
;
-- -----------------------------------------------------------------------------
-- outbound_mark_failed(p_message_id uuid, p_error_code text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outbound_mark_failed(p_message_id uuid, p_error_code text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
  v_code   text;
BEGIN
  SELECT status INTO v_status FROM outbound_messages WHERE id = p_message_id;
  IF NOT found THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND: aviso inexistente';
  END IF;

  v_code := left(regexp_replace(coalesce(p_error_code, 'UNKNOWN'), '[^A-Za-z0-9_\-]', '', 'g'), 64);
  IF v_code = '' THEN v_code := 'UNKNOWN'; END IF;

  UPDATE outbound_messages
     SET status = 'failed',
         error_code = v_code,
         attempts = attempts + 1,
         last_attempt_at = now()
   WHERE id = p_message_id;
  RETURN true;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- outbound_mark_sent(p_message_id uuid, p_provider_message_id text) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outbound_mark_sent(p_message_id uuid, p_provider_message_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM outbound_messages WHERE id = p_message_id;
  IF NOT found THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_FOUND: aviso inexistente';
  END IF;
  IF v_status = 'sent' THEN RETURN true; END IF;

  UPDATE outbound_messages
     SET status = 'sent',
         provider_message_id = coalesce(nullif(trim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
         error_code = NULL,
         attempts = attempts + 1,
         last_attempt_at = now()
   WHERE id = p_message_id;
  RETURN true;
END;
$function$
;
-- -----------------------------------------------------------------------------
-- purge_expired_idempotency_keys() RETURNS bigint
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_idempotency_keys()
 RETURNS bigint
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
  with apagadas as (
    delete from idempotency_keys
     where created_at < now() - make_interval(days => 7)
    returning 1
  )
  select count(*) from apagadas;
$function$
;
-- -----------------------------------------------------------------------------
-- referral_convert(p_tenant_id uuid, p_referred_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.referral_convert(p_tenant_id uuid, p_referred_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_ref public.referrals%rowtype;
  v_cfg public.affiliate_rewards%rowtype;
  v_aff_coupon uuid;
  v_welcome_coupon uuid;
begin
  -- busca a indicacao pending deste cliente
  select * into v_ref
  from public.referrals
  where tenant_id = p_tenant_id
    and referred_user_id = p_referred_user_id
    and status = 'pending'
  for update;

  if not found then
    return null;   -- nada a converter
  end if;

  -- busca a config de premios
  select * into v_cfg
  from public.affiliate_rewards
  where tenant_id = p_tenant_id;

  -- credita cupom de premio pro afiliado (se configurado)
  if v_cfg.affiliate_reward_template_id is not null then
    v_aff_coupon := public.grant_coupon_internal(
      p_tenant_id := p_tenant_id,
      p_template_id := v_cfg.affiliate_reward_template_id,
      p_customer_id := (select customer_id from public.affiliates where id = v_ref.affiliate_id)
    );
  end if;

  -- credita cupom de boas-vindas pro indicado (se configurado)
  if v_cfg.welcome_template_id is not null then
    v_welcome_coupon := public.grant_coupon_internal(
      p_tenant_id := p_tenant_id,
      p_template_id := v_cfg.welcome_template_id,
      p_customer_id := p_referred_user_id
    );
  end if;

  -- marca como convertido
  update public.referrals
  set status = 'converted',
      converted_at = now(),
      reward_coupon_id = v_aff_coupon,
      welcome_coupon_id = v_welcome_coupon
  where id = v_ref.id;

  return jsonb_build_object(
    'affiliateReward', v_aff_coupon,
    'welcomeReward', v_welcome_coupon
  );
end $function$
;
-- -----------------------------------------------------------------------------
-- register_business(p_tenant_slug text, p_name text, p_category text, p_city text, p_phone text, p_email text, p_cnpj text, p_website text, p_logo_url text, p_lat double precision, p_lng double precision, p_internal_code text, p_pin text, p_instagram text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_business(p_tenant_slug text, p_name text, p_category text, p_city text, p_phone text, p_email text, p_cnpj text, p_website text, p_logo_url text, p_lat double precision, p_lng double precision, p_internal_code text, p_pin text, p_instagram text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tenant tenants%rowtype;
  v_owner_id uuid;
  v_business_id uuid;
begin
  SELECT * INTO v_tenant FROM tenants WHERE slug = p_tenant_slug;
  IF NOT found THEN RAISE EXCEPTION 'TENANT_NOT_FOUND'; END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN RAISE EXCEPTION 'INVALID_NAME'; END IF;
  IF p_internal_code IS NULL OR p_internal_code !~ '^[A-Za-z0-9._-]{2,64}$' THEN RAISE EXCEPTION 'INVALID_CODE'; END IF;
  IF length(p_pin) < 6 THEN RAISE EXCEPTION 'WEAK_PIN: minimo de 6 caracteres'; END IF;

  IF EXISTS (SELECT 1 FROM users WHERE tenant_id = v_tenant.id AND internal_code = p_internal_code) THEN
    RAISE EXCEPTION 'CODE_TAKEN: este código de login já está em uso';
  END IF;

  INSERT INTO users (tenant_id, internal_code, role, pin_hash, name, phone, email)
  VALUES (v_tenant.id, p_internal_code, 'MERCHANT', encode(digest(p_pin,'sha256'),'hex'), trim(p_name), p_phone, p_email)
  RETURNING id INTO v_owner_id;

  INSERT INTO businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url, instagram)
  VALUES (v_tenant.id, trim(p_name), coalesce(p_category,'servico'), p_city, p_phone, p_email,
          CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN ST_MakePoint(p_lng,p_lat)::geography ELSE NULL END,
          v_owner_id, 'FREE', 'TRIAL', p_cnpj,
          nullif(btrim(p_website), ''), p_logo_url,
          public.normalize_instagram(p_instagram))
  RETURNING id INTO v_business_id;

  UPDATE users SET business_id = v_business_id WHERE id = v_owner_id;

  RETURN jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id, 'internalCode', p_internal_code);
END $function$
;
-- -----------------------------------------------------------------------------
-- shuttle_cancel_reservation(p_tenant_id uuid, p_customer_id uuid, p_reservation_id uuid, p_reason text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shuttle_cancel_reservation(p_tenant_id uuid, p_customer_id uuid, p_reservation_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_res public.shuttle_reservations%rowtype;
begin
  if p_tenant_id is null or p_customer_id is null or p_reservation_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  select * into v_res
    from public.shuttle_reservations
    where id = p_reservation_id
      and tenant_id = p_tenant_id
      and customer_id = p_customer_id
    for update;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  if v_res.status not in ('pending','confirmed') then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  update public.shuttle_reservations
    set status = 'cancelled',
        reason = nullif(btrim(coalesce(p_reason, '')), ''),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', 'cancelled'
  );
end
$function$
;
-- -----------------------------------------------------------------------------
-- shuttle_create_reservation(p_tenant_id uuid, p_customer_id uuid, p_service_id uuid, p_scheduled_for timestamp with time zone, p_passengers integer, p_notes text, p_contact_phone text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shuttle_create_reservation(p_tenant_id uuid, p_customer_id uuid, p_service_id uuid, p_scheduled_for timestamp with time zone, p_passengers integer, p_notes text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tz            constant text := 'America/Sao_Paulo';
  v_lock_id       uuid;
  v_business_id   uuid;
  v_price_cents   integer;
  v_duration      integer;
  v_opens_at      time;
  v_closes_at     time;
  v_active_days   smallint[];
  v_local         timestamp;
  v_dow           integer;
  v_id            uuid;
begin
  if p_tenant_id is null or p_customer_id is null or p_service_id is null
     or p_scheduled_for is null then
    raise exception 'BAD_REQUEST';
  end if;

  if not exists (
    select 1 from public.users
    where id = p_customer_id and tenant_id = p_tenant_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  if p_passengers is null or p_passengers < 1 or p_passengers > 20 then
    raise exception 'INVALID_PASSENGERS';
  end if;

  select s.id into v_lock_id
    from public.shuttle_services s
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.is_active
    for update;
  if v_lock_id is null then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  select s.business_id, s.price_cents, s.duration_minutes,
         s.opens_at, s.closes_at, s.active_days
    into v_business_id, v_price_cents, v_duration, v_opens_at, v_closes_at, v_active_days
    from public.shuttle_services s
    join public.businesses b on b.id = s.business_id
    where s.id = p_service_id
      and s.tenant_id = p_tenant_id
      and s.is_active
      and b.is_active;
  if v_business_id is null then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  if v_duration is null or v_duration <= 0 then
    v_duration := 60;
  end if;

  if p_scheduled_for <= now() then
    raise exception 'INVALID_SCHEDULE';
  end if;

  v_local := p_scheduled_for at time zone v_tz;
  v_dow   := extract(dow from v_local)::integer;

  if coalesce(array_length(v_active_days, 1), 0) > 0
     and not (v_dow = any (v_active_days)) then
    raise exception 'DAY_NOT_ACTIVE';
  end if;

  if v_opens_at is not null and v_local::time < v_opens_at then
    raise exception 'OUTSIDE_HOURS';
  end if;
  if v_closes_at is not null and v_local::time > v_closes_at then
    raise exception 'OUTSIDE_HOURS';
  end if;

  if exists (
    select 1
    from public.shuttle_reservations r
    where r.shuttle_id = p_service_id
      and r.status in ('pending','confirmed')
      and tstzrange(
            r.scheduled_for,
            r.scheduled_for + make_interval(mins => r.duration_minutes),
            '[)'
          ) && tstzrange(
            p_scheduled_for,
            p_scheduled_for + make_interval(mins => v_duration),
            '[)'
          )
  ) then
    raise exception 'SLOT_CONFLICT';
  end if;

  insert into public.shuttle_reservations (
    tenant_id, business_id, shuttle_id, customer_id, scheduled_for,
    duration_minutes, passengers, price_cents, status, contact_phone, notes
  ) values (
    p_tenant_id, v_business_id, p_service_id, p_customer_id, p_scheduled_for,
    v_duration, p_passengers, v_price_cents, 'pending',
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_id;

  return jsonb_build_object(
    'reservationId',  v_id,
    'shuttleId',      p_service_id,
    'status',         'pending',
    'scheduledFor',   p_scheduled_for,
    'durationMinutes',v_duration,
    'passengers',     p_passengers,
    'priceCents',     v_price_cents,
    'createdAt',      now()
  );
end
$function$
;
-- -----------------------------------------------------------------------------
-- shuttle_list_customer_reservations(p_tenant_id uuid, p_customer_id uuid, p_status text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shuttle_list_customer_reservations(p_tenant_id uuid, p_customer_id uuid, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if p_tenant_id is null or p_customer_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'businessName',    b.name,
        'businessPhone',   b.phone,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        'priceCents',      r.price_cents,
        'status',          r.status,
        'reason',          r.reason,
        'createdAt',       r.created_at
      ) order by r.scheduled_for desc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    join public.businesses b on b.id = r.business_id
    where r.tenant_id = p_tenant_id
      and r.customer_id = p_customer_id
      and (p_status is null or r.status = p_status)
  ), '[]'::jsonb);
end
$function$
;
-- -----------------------------------------------------------------------------
-- trg_referral_reward_link() RETURNS trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_referral_reward_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  -- So interessa conversao que nao creditou premio.
  if new.status = 'converted'
     and new.reward_coupon_id is null
     and new.tenant_id is not null
     and new.affiliate_id is not null then
    perform public.link_affiliate_by_id(new.tenant_id, new.affiliate_id);
  end if;
  return new;
end $function$
;
-- -----------------------------------------------------------------------------
-- try_referral_convert(p_tenant_id uuid, p_customer_id uuid) RETURNS boolean
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.try_referral_convert(p_tenant_id uuid, p_customer_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_result jsonb;
begin
  -- delega para referral_convert (modulo3)
  v_result := public.referral_convert(p_tenant_id, p_customer_id);

  -- true se converteu alguma coisa agora; false se nao havia indicacao
  return (v_result is not null);

exception
  when others then
    -- NUNCA propaga erro: a recompensa e um extra, nao o motivo do resgate.
    return false;
end $function$
;
-- -----------------------------------------------------------------------------
-- validate_and_redeem_coupon(p_tenant_id uuid, p_business_id uuid, p_public_id text, p_raw_token text, p_actor_user_id uuid, p_idempotency_key text, p_short_code text) RETURNS jsonb
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_and_redeem_coupon(p_tenant_id uuid, p_business_id uuid, p_public_id text, p_raw_token text, p_actor_user_id uuid, p_idempotency_key text, p_short_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype; v_coupon coupons%rowtype; v_campaign campaigns%rowtype; v_business businesses%rowtype;
  v_cached jsonb; v_result jsonb; v_charge_cents integer; v_authorized boolean; v_customer users%rowtype; v_template coupon_templates%rowtype;
begin
  select result into v_cached from idempotency_keys where tenant_id=p_tenant_id and operation='coupon.validate' and idempotency_key=p_idempotency_key;
  if v_cached is not null then return v_cached || jsonb_build_object('idempotent', true); end if;
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found then raise exception 'FORBIDDEN: actor not found in tenant'; end if;
  if not v_actor.is_active then raise exception 'USER_DISABLED'; end if;
  if v_actor.role not in ('STAFF','MERCHANT','MANAGER','ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN: role cannot validate coupons'; end if;
  if v_actor.business_id is not null and v_actor.business_id <> p_business_id then raise exception 'FORBIDDEN: actor not authorized for this business'; end if;
  select * into v_coupon from coupons where tenant_id=p_tenant_id and public_id=p_public_id for update;
  if not found then raise exception 'NOT_FOUND: coupon'; end if;
  if v_coupon.business_id <> p_business_id then raise exception 'INVALID_TOKEN: coupon belongs to another business'; end if;
  v_authorized := false;
  if p_raw_token is null and p_short_code is null then v_authorized := true;
  else
    if p_raw_token is not null and v_coupon.secure_token_hash = encode(digest(p_raw_token,'sha256'),'hex') then v_authorized := true; end if;
    if not v_authorized and p_short_code is not null and v_coupon.short_code_hash is not null and v_coupon.short_code_hash = encode(digest(p_short_code,'sha256'),'hex') then v_authorized := true; end if;
  end if;
  if not v_authorized then raise exception 'INVALID_TOKEN'; end if;
  if v_coupon.status = 'CANCELLED' then raise exception 'COUPON_CANCELLED'; end if;
  if v_coupon.status = 'VALIDATED' then raise exception 'COUPON_ALREADY_USED'; end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at < now() then raise exception 'COUPON_EXPIRED'; end if;
  select * into v_campaign from campaigns where id=v_coupon.campaign_id and tenant_id=p_tenant_id;
  if not found or v_campaign.status <> 'PUBLISHED' then raise exception 'NOT_FOUND: campaign not published'; end if;
  select * into v_business from businesses where id=p_business_id and tenant_id=p_tenant_id;
  select * into v_template from coupon_templates where id=v_coupon.template_id;
  select * into v_customer from users where id=v_coupon.customer_id;

  update coupons set status='VALIDATED', validated_at=now(), validated_by_user_id=p_actor_user_id, version=version+1 where id=v_coupon.id and version=v_coupon.version;
  insert into audit_logs (tenant_id, actor_user_id, action, entity, entity_id, metadata) values (p_tenant_id, p_actor_user_id, 'coupon.validated', 'Coupon', v_coupon.id, jsonb_build_object('businessId', p_business_id));

  v_charge_cents := case v_business.billing_plan when 'PRO' then 300 when 'BASIC' then 150 else 0 end;
  if v_charge_cents > 0 then
    insert into billing_charges (tenant_id, business_id, coupon_id, amount_cents) values (p_tenant_id, p_business_id, v_coupon.id, v_charge_cents) on conflict (coupon_id) do nothing;
  end if;

  v_result := jsonb_build_object(
    'couponId', v_coupon.id, 'status', 'VALIDATED', 'validatedAt', now(), 'idempotent', false,
    'offerTitle', v_template.title, 'businessName', v_business.name,
    'customerName', v_customer.name, 'customerPhone', v_customer.phone, 'issuedAt', v_coupon.issued_at
  );
  insert into idempotency_keys (tenant_id, operation, idempotency_key, result) values (p_tenant_id, 'coupon.validate', p_idempotency_key, v_result);
  return v_result;
end $function$
;

-- -----------------------------------------------------------------------------
-- 3. Rewrites (22): contadores/JSON + sessoes/tokens
-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- business_coupon_allowance(p_tenant_id uuid, p_actor_user_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
-- rewrite: business_coupon_allowance(p_tenant_id uuid, p_actor_user_id uuid)
CREATE OR REPLACE FUNCTION public.business_coupon_allowance(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_is_free boolean;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  select (coalesce(b.billing_plan, 'FREE') = 'FREE') into v_is_free
    from businesses b where b.id = v_actor.business_id and b.tenant_id = p_tenant_id;

  if not coalesce(v_is_free, false) then
    return jsonb_build_object('limited', false, 'plan', null, 'allowance', null, 'used', null, 'remaining', null);
  end if;

  return (
    select jsonb_build_object(
      'limited',  true,
      'plan',     coalesce(b.billing_plan, 'FREE'),
      'allowance', b.free_coupon_allowance,
      'used',      (SELECT count(*) FROM public.coupons c WHERE c.business_id = b.id),
      'remaining', greatest(0, b.free_coupon_allowance - (SELECT count(*) FROM public.coupons c WHERE c.business_id = b.id))
    )
    from businesses b
    where b.id = v_actor.business_id and b.tenant_id = p_tenant_id
  );
end;
$function$
;

-- -----------------------------------------------------------------------------
-- claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text, p_customer_email text, p_idempotency_key text) RETURNS jsonb
-- -----------------------------------------------------------------------------
-- rewrite: claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text, p_customer_email text, p_idempotency_key text)
CREATE OR REPLACE FUNCTION public.claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_customer_id uuid;
  v_template coupon_templates%rowtype;
  v_raw_token text;
  v_public_id text;
  v_coupon_id uuid;
  v_already_has int;
  v_short_code text;
  v_cached jsonb;
  v_cipher bytea;
  v_result jsonb;
  v_key text;
  v_is_free boolean;
begin
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;

  if p_idempotency_key is not null then
    select result_enc into v_cipher
      from idempotency_keys
      where tenant_id = p_tenant_id and operation = 'coupon.claim' and idempotency_key = p_idempotency_key;

    if v_cipher is not null then
      select key into v_key from public.idempotency_keys_secret where singleton;
      if v_key is null then
        raise exception 'IDEMPOTENCY_UNAVAILABLE';
      end if;
      begin
        v_cached := pgp_sym_decrypt(v_cipher, v_key)::jsonb;
      exception when others then
        raise exception 'IDEMPOTENCY_UNAVAILABLE';
      end;
      return v_cached || jsonb_build_object('idempotent', true);
    end if;
  end if;

  select id into v_customer_id from users where tenant_id = p_tenant_id and internal_code = p_customer_phone;
  if not found then
    insert into users (tenant_id, internal_code, role, phone, name, instagram, email)
    values (p_tenant_id, p_customer_phone, 'CUSTOMER', p_customer_phone, p_customer_name, p_customer_instagram, p_customer_email) returning id into v_customer_id;
  else
    update users set name = coalesce(p_customer_name, name), instagram = coalesce(p_customer_instagram, instagram), email = coalesce(p_customer_email, email) where id = v_customer_id;
  end if;

  select count(*) into v_already_has from coupons where template_id = p_template_id and customer_id = v_customer_id and status <> 'CANCELLED';
  if v_already_has >= v_template.per_customer_limit then raise exception 'LIMIT_REACHED: customer already claimed this offer'; end if;

  if v_template.total_stock is not null and (SELECT count(*) FROM public.coupons c WHERE c.template_id = v_template.id) >= v_template.total_stock then raise exception 'COUPON_OUT_OF_STOCK'; end if;

  select (coalesce(billing_plan, 'FREE') = 'FREE') into v_is_free
    from businesses where id = v_template.business_id;

  if v_is_free then
    PERFORM 1 FROM public.businesses WHERE id = v_template.business_id FOR UPDATE;
    IF (SELECT count(*) FROM public.coupons c WHERE c.business_id = v_template.business_id) >= (SELECT b.free_coupon_allowance FROM public.businesses b WHERE b.id = v_template.business_id) THEN RAISE EXCEPTION 'FREE_COUPON_QUOTA_EXCEEDED'; END IF;
  end if;

  v_raw_token := encode(gen_random_bytes(32), 'base64');
  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  v_short_code := lpad(floor(random() * 1000000)::text, 6, '0');

  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id, campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id, encode(digest(v_raw_token,'sha256'),'hex'), encode(digest(v_short_code,'sha256'),'hex'), p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id, v_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;

  v_result := jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);

  if p_idempotency_key is not null then
    select key into v_key from public.idempotency_keys_secret where singleton;
    if v_key is null then
      raise exception 'IDEMPOTENCY_UNAVAILABLE';
    end if;
    insert into idempotency_keys (tenant_id, operation, idempotency_key, result_enc)
    values (p_tenant_id, 'coupon.claim', p_idempotency_key, pgp_sym_encrypt(v_result::text, v_key))
    on conflict (tenant_id, operation, idempotency_key) do nothing;
  end if;

  return v_result;
end;
$function$
;

-- -----------------------------------------------------------------------------
-- empresa_dashboard(p_tenant_id uuid, p_business_id uuid) RETURNS jsonb
-- -----------------------------------------------------------------------------
-- rewrite: empresa_dashboard(p_tenant_id uuid, p_business_id uuid)
CREATE OR REPLACE FUNCTION public.empresa_dashboard(p_tenant_id uuid, p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_campaigns jsonb; v_templates jsonb; v_coupons jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb) into v_campaigns from campaigns c where c.tenant_id=p_tenant_id and c.business_id=p_business_id;
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('issued_count', (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id)) order by t.created_at desc), '[]'::jsonb) into v_templates from coupon_templates t where t.tenant_id=p_tenant_id and t.business_id=p_business_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',x.id,'publicId',x.public_id,'status',x.status,'issuedAt',x.issued_at,'validatedAt',x.validated_at,
    'customerName', u.name, 'customerPhone', u.phone
  )), '[]'::jsonb) into v_coupons
  from (select * from coupons where tenant_id=p_tenant_id and business_id=p_business_id order by issued_at desc limit 50) x
  left join users u on u.id = x.customer_id;
  return jsonb_build_object('campaigns', v_campaigns, 'templates', v_templates, 'coupons', v_coupons);
end $function$
;

-- -----------------------------------------------------------------------------
-- find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) RETURNS jsonb
-- -----------------------------------------------------------------------------
-- rewrite: find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision)
CREATE OR REPLACE FUNCTION public.find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.name, 'category', b.category, 'city', b.city,
    'lat', ST_Y(b.location::geometry), 'lng', ST_X(b.location::geometry),
    'logoUrl', b.logo_url,
    'distanceKm', round((ST_Distance(b.location, ST_MakePoint(p_lng,p_lat)::geography) / 1000)::numeric, 2),
    'hasActiveOffer', exists(select 1 from coupon_templates t where t.business_id=b.id and (t.total_stock is null or (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id) < t.total_stock)),
    'offerImageUrl', (select t.image_url from coupon_templates t where t.business_id=b.id and (t.total_stock is null or (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id) < t.total_stock) and t.image_url is not null limit 1)
  ) order by ST_Distance(b.location, ST_MakePoint(p_lng,p_lat)::geography)), '[]'::jsonb)
  into v_result from businesses b
  where b.tenant_id = p_tenant_id and b.is_active and b.location is not null
    and ST_DWithin(b.location, ST_MakePoint(p_lng,p_lat)::geography, p_radius_km * 1000);
  return v_result;
end $function$
;

-- -----------------------------------------------------------------------------
-- grant_coupon_internal(p_tenant_id uuid, p_template_id uuid, p_customer_id uuid) RETURNS uuid
-- -----------------------------------------------------------------------------
-- rewrite: grant_coupon_internal(p_tenant_id uuid, p_template_id uuid, p_customer_id uuid)
CREATE OR REPLACE FUNCTION public.grant_coupon_internal(p_tenant_id uuid, p_template_id uuid, p_customer_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_template coupon_templates%rowtype;
  v_public_id text;
  v_coupon_id uuid;
begin
  if p_customer_id is null then
    return null;   -- afiliado sem customer vinculado = sem cupom
  end if;

  select * into v_template
  from coupon_templates
  where id = p_template_id and tenant_id = p_tenant_id
  for update;

  if not found or not v_template.is_active then
    return null;
  end if;

  if v_template.total_stock is not null and (SELECT count(*) FROM public.coupons c WHERE c.template_id = v_template.id) >= v_template.total_stock then
    return null;   -- sem estoque
  end if;

  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id,
                       campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id,
          encode(digest(v_public_id, 'sha256'), 'hex'),
          encode(digest(v_public_id, 'sha256'), 'hex'),
          p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id,
          p_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;

  return v_coupon_id;
end $function$
;

-- -----------------------------------------------------------------------------
-- list_categories(p_tenant_id uuid) RETURNS text[]
-- -----------------------------------------------------------------------------
-- rewrite: list_categories(p_tenant_id uuid)
CREATE OR REPLACE FUNCTION public.list_categories(p_tenant_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(
    array_agg(n.cat order by n.cat),
    '{}'::text[]
  )
  from (
    select distinct public.norm_categoria(b.category) as cat
    from public.coupon_templates t
    join public.campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
    join public.businesses b on b.id = t.business_id and b.is_active
    where t.tenant_id = p_tenant_id
      and t.is_active
      and (t.total_stock is null or (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id) < t.total_stock)
      and (t.valid_until is null or t.valid_until > now())
      and b.category is not null and b.category <> ''
  ) n;
$function$
;

-- -----------------------------------------------------------------------------
-- list_cities(p_tenant_id uuid) RETURNS text[]
-- -----------------------------------------------------------------------------
-- rewrite: list_cities(p_tenant_id uuid)
CREATE OR REPLACE FUNCTION public.list_cities(p_tenant_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(array_agg(distinct b.city order by b.city), '{}'::text[])
  from coupon_templates t
  join campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id) < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and b.city is not null
    and b.city <> '';
$function$
;

-- -----------------------------------------------------------------------------
-- list_offers(p_tenant_id uuid, p_city text, p_category text, p_lat double precision, p_lng double precision, p_radius_km double precision) RETURNS jsonb
-- -----------------------------------------------------------------------------
-- rewrite: list_offers(p_tenant_id uuid, p_city text, p_category text, p_lat double precision, p_lng double precision, p_radius_km double precision)
CREATE OR REPLACE FUNCTION public.list_offers(p_tenant_id uuid, p_city text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_radius_km double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'templateId', t.id,
      'title', t.title,
      'benefitType', t.benefit_type,
      'benefitValue', t.benefit_value,
      'businessId', b.id,
      'businessName', b.name,
      'category', b.category,
      'city', b.city,
      'imageUrl', t.image_url,
      'logoUrl', b.logo_url,
      'businessPhone', b.phone,
      'businessWebsite', b.website,
      'businessInstagram', b.instagram,
      'featuredRank', b.featured_rank,
      'featured', (t.featured_until is not null and t.featured_until > now()),
      'featuredUntil', t.featured_until,
      'distanceKm',
        case when p_lat is not null and b.location is not null
             then round((st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) / 1000)::numeric, 2)
             else null end
    ) order by
      (t.featured_until is not null and t.featured_until > now()) desc,
      b.featured_rank desc,
      case when p_lat is not null and b.location is not null
           then st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) else null end asc,
      b.name asc,
      t.title asc
  ), '[]'::jsonb)
  from public.coupon_templates t
  join public.campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join public.businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or (SELECT count(*) FROM public.coupons c WHERE c.template_id = t.id) < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and (p_city is null or lower(b.city) = lower(p_city))
    and (p_category is null or public.norm_categoria(b.category) = public.norm_categoria(p_category))
    and (p_radius_km is null or p_lat is null or p_lng is null
         or (b.location is not null
             and st_dwithin(b.location, st_makepoint(p_lng, p_lat)::geography, p_radius_km * 1000)));
$function$
;

-- -----------------------------------------------------------------------------
-- referral_track(p_tenant_id uuid, p_referral_code text, p_referred_user_id uuid) RETURNS void
-- -----------------------------------------------------------------------------
-- rewrite: referral_track(p_tenant_id uuid, p_referral_code text, p_referred_user_id uuid)
CREATE OR REPLACE FUNCTION public.referral_track(p_tenant_id uuid, p_referral_code text, p_referred_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_aff public.affiliates%rowtype;
begin
  if p_referral_code is null or p_referral_code = '' then
    return;   -- sem codigo = sem indicacao, segue normal
  end if;

  select * into v_aff
  from public.affiliates
  where tenant_id = p_tenant_id
    and referral_code = upper(p_referral_code)
    and reward_status = 'active';

  if not found then
    return;   -- codigo invalido/inativo = segue normal (fail-open)
  end if;

  -- nao permite auto-indicacao (afiliado indicando a si mesmo)
  if v_aff.customer_id is not null and v_aff.customer_id = p_referred_user_id then
    return;
  end if;

  -- um cliente so pode ser indicado uma vez por tenant
  if exists (
    select 1 from public.referrals
    where tenant_id = p_tenant_id
      and referred_user_id = p_referred_user_id
  ) then
    return;
  end if;

  insert into public.referrals (tenant_id, affiliate_id, referred_user_id, status)
  values (p_tenant_id, v_aff.id, p_referred_user_id, 'pending');
end $function$
;

-- rewrite: auth_login(p_tenant_slug text, p_internal_code text, p_pin text)
CREATE OR REPLACE FUNCTION public.auth_login(p_tenant_slug text, p_internal_code text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_tenant tenants%rowtype; v_user users%rowtype; v_session_token uuid; v_attempt login_attempts%rowtype;
begin
  select * into v_tenant from tenants where slug = p_tenant_slug;
  if not found then raise exception 'NOT_FOUND: tenant'; end if;
  -- login agora ignora maiuscula/minuscula no codigo (causa raiz do problema EDTECSEG)
  select * into v_user from users where tenant_id = v_tenant.id and lower(internal_code) = lower(p_internal_code);
  if not found then return jsonb_build_object('error', 'INVALID_CREDENTIALS'); end if;
  select * into v_attempt from login_attempts where tenant_id = v_tenant.id and subject_kind = 'user' and subject_key = lower(p_internal_code) for update;
  if found and v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return jsonb_build_object('error', 'ACCOUNT_LOCKED');
  end if;
  if not v_user.is_active then return jsonb_build_object('error', 'USER_DISABLED'); end if;
  if v_user.pin_hash is null or v_user.pin_hash <> encode(digest(p_pin, 'sha256'), 'hex') then
    insert into login_attempts (tenant_id, subject_kind, subject_key, fail_count, locked_until) values (v_tenant.id, 'user', lower(p_internal_code), 1, null)
    on conflict (tenant_id, subject_kind, subject_key) do update set fail_count = login_attempts.fail_count + 1,
      locked_until = case when login_attempts.fail_count + 1 >= 5 then now() + interval '5 minutes' else null end;
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;
  delete from login_attempts where tenant_id = v_tenant.id and subject_kind = 'user' and subject_key = lower(p_internal_code);
  insert into sessions (tenant_id, user_id) values (v_tenant.id, v_user.id) returning token into v_session_token;
  return jsonb_build_object('sessionToken', v_session_token, 'userId', v_user.id, 'tenantId', v_tenant.id, 'role', v_user.role, 'businessId', v_user.business_id);
end $function$
;

-- rewrite: auth_verify_session(p_session_token uuid)
CREATE OR REPLACE FUNCTION public.auth_verify_session(p_session_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_session sessions%rowtype; v_user users%rowtype;
begin
  select * into v_session from sessions where token = p_session_token and expires_at > now() and kind = 'user';
  if not found then raise exception 'SESSION_EXPIRED'; end if;
  select * into v_user from users where id = v_session.user_id;
  return jsonb_build_object('userId', v_user.id, 'tenantId', v_user.tenant_id, 'role', v_user.role, 'businessId', v_user.business_id, 'internalCode', v_user.internal_code);
end $function$
;

-- rewrite: admin_driver_reset_pin(p_tenant_id uuid, p_actor_user_id uuid, p_driver_id uuid, p_new_pin text)
CREATE OR REPLACE FUNCTION public.admin_driver_reset_pin(p_tenant_id uuid, p_actor_user_id uuid, p_driver_id uuid, p_new_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor users%rowtype;
  v_driver drivers%rowtype;
begin
  if p_new_pin is null or not (p_new_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;

  -- Papel antes de escopo. CUSTOMER mora na mesma tabela `users` e tem
  -- business_id NULL, entao a regra de business_id abaixo nao o segura: para um
  -- motorista INDEPENDENTE (business_id NULL) ela nunca dispara e a conta de
  -- cliente passaria.
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_driver from drivers where id = p_driver_id and tenant_id = p_tenant_id;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- Mesma regra de escopo de driver_review_document / driver_list_for_business:
  -- SUPER_ADMIN ve todos; uma empresa gerencia os proprios motoristas E os
  -- independentes (business_id NULL).
  if v_actor.role <> 'SUPER_ADMIN'
     and v_driver.business_id is not null
     and v_actor.business_id is distinct from v_driver.business_id then
    raise exception 'FORBIDDEN: so a empresa do motorista ou o admin';
  end if;

  update drivers
  set pin_hash = crypt(p_new_pin, gen_salt('bf')),
      pin_updated_at = now(),
      updated_at = now()
  where id = p_driver_id;

  -- derruba as sessoes: se o PIN vazou, o acesso antigo tem que cair
  delete from public.sessions where driver_id = p_driver_id and kind = 'driver';

  return jsonb_build_object('ok', true, 'driverId', p_driver_id, 'sessionsRevoked', true);
end $function$
;

-- rewrite: driver_add_document(p_tenant_id uuid, p_driver_id uuid, p_doc_type text, p_doc_url text, p_doc_number text, p_doc_expires_at date, p_session_token uuid, p_upload_token text)
CREATE OR REPLACE FUNCTION public.driver_add_document(p_tenant_id uuid, p_driver_id uuid, p_doc_type text, p_doc_url text, p_doc_number text DEFAULT NULL::text, p_doc_expires_at date DEFAULT NULL::date, p_session_token uuid DEFAULT NULL::uuid, p_upload_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_driver public.drivers%rowtype;
  v_doc_id uuid;
begin
  if p_doc_type not in ('cnh', 'rg', 'crv') then raise exception 'DOC_TYPE_INVALID'; end if;
  if p_doc_url is null or btrim(p_doc_url) = '' then raise exception 'DOC_URL_REQUIRED'; end if;
  if length(p_doc_url) > 500 then raise exception 'DOC_URL_TOO_LONG'; end if;

  if p_session_token is not null then
    select * into v_driver from public.drivers
    where id = p_driver_id and tenant_id = p_tenant_id
      and exists (
        select 1 from public.sessions s
        where s.token = p_session_token and s.driver_id = p_driver_id and s.expires_at > now() and s.kind = 'driver'
      );
    if not found then raise exception 'FORBIDDEN'; end if;
  elsif p_upload_token is not null and btrim(p_upload_token) <> '' then
    select * into v_driver from public.drivers
    where id = p_driver_id and tenant_id = p_tenant_id and status in ('pending', 'rejected')
      and exists (
        select 1 from public.magic_tokens t
        where t.driver_id = p_driver_id and t.purpose = 'upload'
          and t.token_hash = encode(digest(btrim(p_upload_token), 'sha256'), 'hex')
          and t.expires_at > now()
      );
    if not found then raise exception 'FORBIDDEN'; end if;
  else
    raise exception 'AUTH_REQUIRED';
  end if;

  delete from public.driver_documents where driver_id = p_driver_id and doc_type = p_doc_type;

  insert into public.driver_documents (tenant_id, driver_id, doc_type, doc_url, doc_number, doc_expires_at, status)
  values (p_tenant_id, p_driver_id, p_doc_type, btrim(p_doc_url), nullif(trim(coalesce(p_doc_number,'')),''), p_doc_expires_at, 'pending')
  returning id into v_doc_id;

  update public.drivers
  set status = case when status = 'approved' then 'pending' else status end, updated_at = now()
  where id = p_driver_id;

  return jsonb_build_object('documentId', v_doc_id, 'status', 'pending');
end
$function$
;

-- rewrite: driver_complete_shuttle_reservation(p_session_token uuid, p_reservation_id uuid)
CREATE OR REPLACE FUNCTION public.driver_complete_shuttle_reservation(p_session_token uuid, p_reservation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_drivers public.drivers%rowtype;
  v_res     public.shuttle_reservations%rowtype;
begin
  select d.* into v_drivers
    from public.sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now()
      and s.kind = 'driver';
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  if p_reservation_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  select r.* into v_res
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    where r.id = p_reservation_id
      and r.tenant_id = v_drivers.tenant_id
      and s.business_id = v_drivers.business_id
    for update of r;
  if v_res.id is null then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  if v_res.status <> 'confirmed' then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  update public.shuttle_reservations
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where id = v_res.id;

  return jsonb_build_object(
    'reservationId', v_res.id,
    'status', 'completed',
    'completedAt', now()
  );
end
$function$
;

-- rewrite: driver_list_shuttle_runs(p_session_token uuid, p_date date)
CREATE OR REPLACE FUNCTION public.driver_list_shuttle_runs(p_session_token uuid, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tz      constant text := 'America/Sao_Paulo';
  v_drivers public.drivers%rowtype;
  v_day     date;
begin
  select d.* into v_drivers
    from public.sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now()
      and s.kind = 'driver';
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  v_day := coalesce(p_date, (now() at time zone v_tz)::date);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'reservationId',   r.id,
        'shuttleId',       r.shuttle_id,
        'serviceName',     s.name,
        'scheduledFor',    r.scheduled_for,
        'durationMinutes', r.duration_minutes,
        'passengers',      r.passengers,
        'origin',          jsonb_build_object(
                             'lat', ST_Y(s.origin::geometry),
                             'lng', ST_X(s.origin::geometry)),
        'destination',     jsonb_build_object(
                             'lat', ST_Y(s.destination::geometry),
                             'lng', ST_X(s.destination::geometry)),
        'status',          r.status
      ) order by r.scheduled_for asc
    )
    from public.shuttle_reservations r
    join public.shuttle_services s on s.id = r.shuttle_id
    where r.tenant_id = v_drivers.tenant_id
      and s.business_id = v_drivers.business_id
      and r.status in ('confirmed','completed')
      and (r.scheduled_for at time zone v_tz)::date = v_day
  ), '[]'::jsonb);
end
$function$
;

-- rewrite: driver_login(p_tenant_id uuid, p_phone text, p_pin text)
CREATE OR REPLACE FUNCTION public.driver_login(p_tenant_id uuid, p_phone text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_phone text;
  v_driver drivers%rowtype;
  v_token uuid;
  v_attempt login_attempts%rowtype;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_phone = '' or p_pin is null then
    return jsonb_build_object('error', 'CREDENTIALS_REQUIRED');
  end if;

  -- bloqueio por tentativas (chave = telefone)
  select * into v_attempt
  from login_attempts
  where tenant_id = p_tenant_id and subject_kind = 'driver' and subject_key = v_phone
  for update;
  if found and v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return jsonb_build_object('error', 'ACCOUNT_LOCKED');
  end if;

  select * into v_driver
  from drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = v_phone;

  if not found then
    -- nao diga se o telefone existe: mesma resposta para telefone errado
    -- e senha errada, para nao vazar cadastro.
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  -- confere o PIN (bcrypt). Mesma resposta para PIN errado e nao definido.
  if v_driver.pin_hash is null or crypt(p_pin, v_driver.pin_hash) <> v_driver.pin_hash then
    -- 5 falhas => 15 min de bloqueio, mais duro que os 5 min do auth_login porque
    -- um PIN de 4-8 digitos e adivinhavel por forca bruta. Reinicio de PIN e
    -- feito pela empresa (admin_driver_reset_pin).
    insert into login_attempts (tenant_id, subject_kind, subject_key, fail_count, locked_until)
    values (p_tenant_id, 'driver', v_phone, 1, null)
    on conflict (tenant_id, subject_kind, subject_key) do update
      set fail_count = login_attempts.fail_count + 1,
          locked_until = case
            when login_attempts.fail_count + 1 >= 5
              then now() + interval '15 minutes'
            else login_attempts.locked_until
          end;
    return jsonb_build_object('error', 'INVALID_CREDENTIALS');
  end if;

  -- PIN certo. So a suspensao fecha o acesso: 'pending' e 'rejected' entram no
  -- app (o primeiro precisa enviar documento, o segundo precisa reenviar o
  -- corrigido) e recebem a situacao no corpo da sessao para a tela mostrar.
  --
  -- Antes esta condicao era `status <> 'approved'`, que negava o login antes de
  -- qualquer sessao ser emitida.
  if v_driver.status = 'suspended' then
    return jsonb_build_object('error', 'ACCOUNT_SUSPENDED', 'status', v_driver.status);
  end if;

  -- login ok: limpa tentativas e emite sessao
  delete from login_attempts where tenant_id = p_tenant_id and subject_kind = 'driver' and subject_key = v_phone;

  insert into public.sessions (tenant_id, driver_id, kind, expires_at)
  values (p_tenant_id, v_driver.id, 'driver', now() + '30 days'::interval)
  returning token into v_token;

  return jsonb_build_object(
    'sessionToken', v_token,
    'driverId', v_driver.id,
    'tenantId', p_tenant_id,
    'name', v_driver.name,
    'phone', v_driver.phone,
    'businessId', v_driver.business_id,
    'status', v_driver.status
  );
end $function$
;

-- rewrite: driver_logout(p_session_token uuid)
CREATE OR REPLACE FUNCTION public.driver_logout(p_session_token uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public', 'extensions'
AS $function$
  delete from public.sessions where token = p_session_token and kind = 'driver';
$function$
;

-- rewrite: driver_report_position(p_session_token uuid, p_lat double precision, p_lng double precision, p_heading double precision, p_speed_kmh double precision, p_shuttle_id uuid, p_accuracy_m double precision)
CREATE OR REPLACE FUNCTION public.driver_report_position(p_session_token uuid, p_lat double precision, p_lng double precision, p_heading double precision DEFAULT NULL::double precision, p_speed_kmh double precision DEFAULT NULL::double precision, p_shuttle_id uuid DEFAULT NULL::uuid, p_accuracy_m double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_drivers drivers%rowtype;
  v_recorded timestamptz;
begin
  select d.* into v_drivers
    from public.sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now()
      and s.kind = 'driver';
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90
     or p_lng < -180 or p_lng > 180 then
    raise exception 'INVALID_COORDS';
  end if;
  if p_heading is not null and (p_heading < 0 or p_heading >= 360) then
    raise exception 'INVALID_HEADING';
  end if;
  if p_speed_kmh is not null and p_speed_kmh < 0 then
    raise exception 'INVALID_SPEED';
  end if;
  if p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 100000) then
    raise exception 'INVALID_ACCURACY';
  end if;
  if p_shuttle_id is not null and not exists (
    select 1 from public.shuttle_services s
    where s.id = p_shuttle_id
      and s.tenant_id = v_drivers.tenant_id
      and s.is_active
  ) then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  insert into public.vehicle_positions (
    tenant_id, driver_id, shuttle_id, lat, lng, heading, speed_kmh, accuracy_m, recorded_at
  ) values (
    v_drivers.tenant_id, v_drivers.id, p_shuttle_id, p_lat, p_lng,
    p_heading, p_speed_kmh, p_accuracy_m, now()
  )
  on conflict (driver_id) do update set
    tenant_id = excluded.tenant_id,
    shuttle_id = excluded.shuttle_id,
    lat = excluded.lat,
    lng = excluded.lng,
    heading = excluded.heading,
    speed_kmh = excluded.speed_kmh,
    accuracy_m = excluded.accuracy_m,
    recorded_at = excluded.recorded_at
  returning recorded_at into v_recorded;

  return jsonb_build_object('driverId', v_drivers.id, 'recordedAt', v_recorded);
end $function$
;

-- rewrite: driver_verify_session(p_session_token uuid)
CREATE OR REPLACE FUNCTION public.driver_verify_session(p_session_token uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  -- 'suspended' fica de fora de proposito: e o unico status que derruba a sessao
  -- ja aberta no meio da navegacao, sem esperar o token expirar. A empresa
  -- suspende e o motorista perde o acesso na proxima chamada.
  select case when d.id is null then null else jsonb_build_object(
    'driverId', d.id,
    'tenantId', d.tenant_id,
    'name', d.name,
    'phone', d.phone,
    'email', d.email,
    'businessId', d.business_id,
    'status', d.status
  ) end
  from sessions s
  join drivers d on d.id = s.driver_id
  where s.token = p_session_token
    and s.expires_at > now()
    and s.kind = 'driver'
    and d.status <> 'suspended'
  limit 1;
$function$
;

-- rewrite: business_generate_invite(p_tenant_id uuid, p_actor_user_id uuid, p_max_uses integer, p_expires_hours integer)
CREATE OR REPLACE FUNCTION public.business_generate_invite(p_tenant_id uuid, p_actor_user_id uuid, p_max_uses integer DEFAULT 1, p_expires_hours integer DEFAULT 72)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_actor   public.users%rowtype;
  v_code    text;
  v_expires timestamptz;
begin
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 100 then raise exception 'INVITE_MAX_USES_INVALID'; end if;
  if p_expires_hours is null or p_expires_hours < 1 or p_expires_hours > 720 then raise exception 'INVITE_EXPIRES_INVALID'; end if;
  select * into v_actor from public.users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if not coalesce(v_actor.is_active, false) then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if v_actor.business_id is null or not exists (select 1 from public.businesses where id = v_actor.business_id and tenant_id = p_tenant_id) then raise exception 'FORBIDDEN'; end if;
  v_code    := upper(encode(gen_random_bytes(6), 'hex'));
  v_expires := now() + make_interval(hours => p_expires_hours);
  insert into public.magic_tokens (tenant_id, business_id, purpose, token_hash, max_uses, expires_at, created_by)
  values (p_tenant_id, v_actor.business_id, 'business_invite', encode(digest(upper(btrim(v_code)), 'sha256'), 'hex'), p_max_uses, v_expires, p_actor_user_id);
  return jsonb_build_object('code', v_code, 'businessId', v_actor.business_id, 'maxUses', p_max_uses, 'expiresAt', v_expires);
end
$function$
;

-- rewrite: driver_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_business_id uuid, p_invite_code text, p_cpf text, p_cnpj text, p_legal_name text)
CREATE OR REPLACE FUNCTION public.driver_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_business_id uuid DEFAULT NULL::uuid, p_invite_code text DEFAULT NULL::text, p_cpf text DEFAULT NULL::text, p_cnpj text DEFAULT NULL::text, p_legal_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_phone        text;
  v_email        text;
  v_driver_id    uuid;
  v_invite       public.magic_tokens%rowtype;
  v_business_id  uuid;
  v_pin_token    text;
  v_upload_token text;
  v_recent       integer;
  v_cpf          text;
  v_cnpj         text;
  v_legal_name   text;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  if p_name is null or btrim(p_name) = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_phone) < 10 then raise exception 'PHONE_INVALID'; end if;
  if v_email not like '%@%' then raise exception 'EMAIL_INVALID'; end if;
  if length(v_phone) > 15 then raise exception 'PHONE_INVALID'; end if;
  if length(btrim(p_name)) > 120 then raise exception 'NAME_TOO_LONG'; end if;

  v_cpf        := nullif(public.digits_only(p_cpf), '');
  v_cnpj       := nullif(public.digits_only(p_cnpj), '');
  v_legal_name := nullif(btrim(coalesce(p_legal_name, '')), '');

  if v_cpf is null then
    raise exception 'CPF_REQUIRED';
  end if;
  if not public.is_valid_cpf(v_cpf) then
    raise exception 'CPF_INVALID';
  end if;

  if v_cnpj is not null and not public.is_valid_cnpj(v_cnpj) then
    raise exception 'CNPJ_INVALID';
  end if;
  if v_cnpj is not null and v_legal_name is null then
    raise exception 'LEGAL_NAME_REQUIRED';
  end if;
  if v_legal_name is not null and length(v_legal_name) > 160 then
    raise exception 'LEGAL_NAME_TOO_LONG';
  end if;

  select count(*) into v_recent
  from public.drivers
  where tenant_id = p_tenant_id and created_at > now() - interval '1 hour';
  if v_recent >= 20 then raise exception 'REGISTRATION_RATE_LIMITED'; end if;

  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and regexp_replace(phone,'\D','','g') = v_phone) then
    raise exception 'PHONE_ALREADY_REGISTERED';
  end if;

  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and lower(email) = v_email) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  if exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and cpf = v_cpf
  ) then
    raise exception 'CPF_ALREADY_REGISTERED';
  end if;

  if v_cnpj is not null and exists (
    select 1 from public.drivers where tenant_id = p_tenant_id and cnpj = v_cnpj
  ) then
    raise exception 'CNPJ_ALREADY_REGISTERED';
  end if;

  v_business_id := p_business_id;
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    select * into v_invite
    from public.magic_tokens
    where tenant_id = p_tenant_id and purpose = 'business_invite' and token_hash = encode(digest(upper(btrim(p_invite_code)), 'sha256'), 'hex')
    for update;
    if not found then raise exception 'INVITE_INVALID'; end if;
    if v_invite.revoked_at is not null then raise exception 'INVITE_INVALID'; end if;
    if v_invite.expires_at is not null and v_invite.expires_at <= now() then raise exception 'INVITE_EXPIRED'; end if;
    if v_invite.uses >= v_invite.max_uses then raise exception 'INVITE_EXHAUSTED'; end if;
    if v_invite.business_id is not null then
      if p_business_id is not null and p_business_id <> v_invite.business_id then raise exception 'INVITE_BUSINESS_MISMATCH'; end if;
      v_business_id := v_invite.business_id;
    end if;
  end if;

  if v_business_id is not null then
    if not exists (select 1 from public.businesses where id = v_business_id and tenant_id = p_tenant_id) then
      raise exception 'BUSINESS_NOT_FOUND';
    end if;
  end if;

  insert into public.drivers (tenant_id, name, phone, email, business_id, status, cpf, cnpj, legal_name)
  values (p_tenant_id, btrim(p_name), v_phone, v_email, v_business_id, 'pending',
          v_cpf, v_cnpj, v_legal_name)
  returning id into v_driver_id;

  v_pin_token    := encode(gen_random_bytes(32), 'hex');
  v_upload_token := encode(gen_random_bytes(32), 'hex');
  insert into public.magic_tokens (tenant_id, driver_id, purpose, token_hash, expires_at)
  values
    (p_tenant_id, v_driver_id, 'pin',    encode(digest(v_pin_token,    'sha256'), 'hex'), now() + interval '2 hours'),
    (p_tenant_id, v_driver_id, 'upload', encode(digest(v_upload_token, 'sha256'), 'hex'), now() + interval '24 hours');

  if v_invite.id is not null then
    update public.magic_tokens set uses = uses + 1 where id = v_invite.id;
  end if;

  return jsonb_build_object(
    'driverId', v_driver_id,
    'status', 'pending',
    'pinToken', v_pin_token,
    'uploadToken', v_upload_token,
    'message', 'Cadastro criado. Defina seu PIN, envie os documentos e aguarde a aprovacao da empresa.'
  );
end $function$
;

-- rewrite: driver_set_pin(p_tenant_id uuid, p_phone text, p_pin text, p_pin_token text)
CREATE OR REPLACE FUNCTION public.driver_set_pin(p_tenant_id uuid, p_phone text, p_pin text, p_pin_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_driver public.drivers%rowtype;
begin
  if p_pin is null or not (p_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_driver
  from public.drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  if p_pin_token is null or btrim(p_pin_token) = '' then raise exception 'AUTH_REQUIRED'; end if;

  if not exists (
    select 1 from public.magic_tokens t
    where t.driver_id = v_driver.id and t.purpose = 'pin'
      and t.token_hash = encode(digest(btrim(p_pin_token), 'sha256'), 'hex')
      and t.expires_at > now()
  ) then
    raise exception 'TOKEN_INVALID';
  end if;

  if v_driver.status not in ('pending', 'rejected') then raise exception 'TOKEN_INVALID'; end if;

  update public.drivers
  set pin_hash = crypt(p_pin, gen_salt('bf')), pin_updated_at = now(), updated_at = now()
  where id = v_driver.id;

  delete from public.magic_tokens
  where driver_id = v_driver.id
    and purpose = 'pin'
    and token_hash = encode(digest(btrim(p_pin_token), 'sha256'), 'hex');

  return jsonb_build_object('ok', true, 'driverId', v_driver.id);
end;
$function$
;

-- -----------------------------------------------------------------------------
-- 4. Grants — Replicam o inventario de producao (anon/authenticated sem
--    EXECUTE; service_role com EXECUTE). Regra 4: cada patch fecha a funcao
--    que recria, porque CREATE nasce com EXECUTE para PUBLIC.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_affiliate_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_affiliate_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_billing_panel(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_billing_panel(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_create_business(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_category text, p_city text, p_phone text, p_email text, p_lat double precision, p_lng double precision, p_owner_internal_code text, p_owner_pin text, p_billing_plan text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_business(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_category text, p_city text, p_phone text, p_email text, p_lat double precision, p_lng double precision, p_owner_internal_code text, p_owner_pin text, p_billing_plan text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_delete_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(p_tenant_id uuid, p_actor_user_id uuid, p_driver_id uuid, p_new_pin text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_driver_reset_pin(p_tenant_id uuid, p_actor_user_id uuid, p_driver_id uuid, p_new_pin text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_featured_ranks(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_featured_ranks(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_get_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_list_businesses(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_businesses(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_list_customers(p_tenant_id uuid, p_actor_user_id uuid, p_search text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_customers(p_tenant_id uuid, p_actor_user_id uuid, p_search text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_request_password_reset(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_request_password_reset(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid, p_affiliate_reward_template_id uuid, p_welcome_template_id uuid, p_require_first_claim boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_affiliate_rewards(p_tenant_id uuid, p_actor_user_id uuid, p_affiliate_reward_template_id uuid, p_welcome_template_id uuid, p_require_first_claim boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_billing(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_plan text, p_status text, p_fee_cents integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_billing(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_plan text, p_status text, p_fee_cents integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_featured(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_featured_rank integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_featured(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_featured_rank integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_is_active boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_is_active boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_update_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_name text, p_phone text, p_email text, p_category text, p_city text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_business(p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_name text, p_phone text, p_email text, p_category text, p_city text, p_cnpj text, p_website text, p_logo_url text, p_instagram text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.admin_update_customer(p_tenant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_name text, p_email text, p_instagram text, p_is_active boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_customer(p_tenant_id uuid, p_actor_user_id uuid, p_customer_id uuid, p_name text, p_email text, p_instagram text, p_is_active boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.affiliate_dashboard(p_tenant_id uuid, p_affiliate_id uuid, p_phone text, p_de timestamp with time zone, p_ate timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.affiliate_dashboard(p_tenant_id uuid, p_affiliate_id uuid, p_phone text, p_de timestamp with time zone, p_ate timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.affiliate_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_kind text, p_referral_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.affiliate_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_kind text, p_referral_code text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.affiliate_reward_status(p_tenant_id uuid, p_affiliate_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.affiliate_reward_status(p_tenant_id uuid, p_affiliate_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.auth_login(p_tenant_slug text, p_internal_code text, p_pin text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login(p_tenant_slug text, p_internal_code text, p_pin text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.auth_pin_reset_required(p_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_pin_reset_required(p_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.auth_set_pin(p_tenant_id uuid, p_internal_code text, p_pin text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_pin(p_tenant_id uuid, p_internal_code text, p_pin text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.auth_verify_session(p_session_token uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_verify_session(p_session_token uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_cancel(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mp_cancel(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_prepare(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mp_prepare(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_register(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_subscription_id text, p_subscription_url text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mp_register(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_subscription_id text, p_subscription_url text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_webhook_charge(p_subscription_id text, p_payment_id text, p_amount_cents integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mp_webhook_charge(p_subscription_id text, p_payment_id text, p_amount_cents integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_mp_webhook_preapproval(p_subscription_id text, p_status text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mp_webhook_preapproval(p_subscription_id text, p_status text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.billing_record_coupon_tax(p_tenant_id uuid, p_template_id uuid, p_coupon_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_record_coupon_tax(p_tenant_id uuid, p_template_id uuid, p_coupon_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_coupon_allowance(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_coupon_allowance(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_coupon_stats(p_tenant_id uuid, p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_coupon_stats(p_tenant_id uuid, p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_delete_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_delete_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_delete_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_delete_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_generate_invite(p_tenant_id uuid, p_actor_user_id uuid, p_max_uses integer, p_expires_hours integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_generate_invite(p_tenant_id uuid, p_actor_user_id uuid, p_max_uses integer, p_expires_hours integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_list_shuttle_reservations(p_tenant_id uuid, p_actor_user_id uuid, p_status text, p_date date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_list_shuttle_reservations(p_tenant_id uuid, p_actor_user_id uuid, p_status text, p_date date) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_list_shuttle_services(p_tenant_id uuid, p_actor_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_list_shuttle_services(p_tenant_id uuid, p_actor_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_logo_by_id(p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_logo_by_id(p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_public_card(p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_public_card(p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_report(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_report_v3(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_report_v3(p_tenant_id uuid, p_actor_user_id uuid, p_de timestamp with time zone, p_ate timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_review_shuttle_reservation(p_tenant_id uuid, p_actor_user_id uuid, p_reservation_id uuid, p_action text, p_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_review_shuttle_reservation(p_tenant_id uuid, p_actor_user_id uuid, p_reservation_id uuid, p_action text, p_reason text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_save_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_name text, p_description text, p_service_type text, p_origin_lat double precision, p_origin_lng double precision, p_dest_lat double precision, p_dest_lng double precision, p_stops jsonb, p_price_cents integer, p_opens_at time without time zone, p_closes_at time without time zone, p_active_days smallint[], p_duration_minutes integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_save_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_name text, p_description text, p_service_type text, p_origin_lat double precision, p_origin_lng double precision, p_dest_lat double precision, p_dest_lng double precision, p_stops jsonb, p_price_cents integer, p_opens_at time without time zone, p_closes_at time without time zone, p_active_days smallint[], p_duration_minutes integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_set_coupon_featured(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_until timestamp with time zone) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_set_pin(p_tenant_id uuid, p_actor_user_id uuid, p_new_pin text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_set_pin(p_tenant_id uuid, p_actor_user_id uuid, p_new_pin text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_toggle_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_is_active boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_toggle_shuttle_service(p_tenant_id uuid, p_actor_user_id uuid, p_service_id uuid, p_is_active boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_toggle_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_is_active boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_toggle_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_is_active boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_update_own(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_phone text, p_email text, p_city text, p_logo_url text, p_category text, p_lat double precision, p_lng double precision, p_website text, p_instagram text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_update_own(p_tenant_id uuid, p_actor_user_id uuid, p_name text, p_phone text, p_email text, p_city text, p_logo_url text, p_category text, p_lat double precision, p_lng double precision, p_website text, p_instagram text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.business_update_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_update_template(p_tenant_id uuid, p_actor_user_id uuid, p_template_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text, p_customer_email text, p_idempotency_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text, p_customer_email text, p_idempotency_key text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.create_campaign(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_title text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_campaign(p_tenant_id uuid, p_business_id uuid, p_actor_user_id uuid, p_title text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.create_coupon_template(p_tenant_id uuid, p_business_id uuid, p_campaign_id uuid, p_actor_user_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_coupon_template(p_tenant_id uuid, p_business_id uuid, p_campaign_id uuid, p_actor_user_id uuid, p_title text, p_benefit_type text, p_benefit_value numeric, p_total_stock integer, p_image_url text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.digits_only(p_raw text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.digits_only(p_raw text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_add_document(p_tenant_id uuid, p_driver_id uuid, p_doc_type text, p_doc_url text, p_doc_number text, p_doc_expires_at date, p_session_token uuid, p_upload_token text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_add_document(p_tenant_id uuid, p_driver_id uuid, p_doc_type text, p_doc_url text, p_doc_number text, p_doc_expires_at date, p_session_token uuid, p_upload_token text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_complete_shuttle_reservation(p_session_token uuid, p_reservation_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_complete_shuttle_reservation(p_session_token uuid, p_reservation_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_get_document_path(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_get_document_path(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_list_for_business(p_tenant_id uuid, p_actor_user_id uuid, p_status text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_list_for_business(p_tenant_id uuid, p_actor_user_id uuid, p_status text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_list_shuttle_runs(p_session_token uuid, p_date date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_list_shuttle_runs(p_session_token uuid, p_date date) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_login(p_tenant_id uuid, p_phone text, p_pin text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_login(p_tenant_id uuid, p_phone text, p_pin text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_logout(p_session_token uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_logout(p_session_token uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_business_id uuid, p_invite_code text, p_cpf text, p_cnpj text, p_legal_name text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_register(p_tenant_id uuid, p_name text, p_phone text, p_email text, p_business_id uuid, p_invite_code text, p_cpf text, p_cnpj text, p_legal_name text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_report_position(p_session_token uuid, p_lat double precision, p_lng double precision, p_heading double precision, p_speed_kmh double precision, p_shuttle_id uuid, p_accuracy_m double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_report_position(p_session_token uuid, p_lat double precision, p_lng double precision, p_heading double precision, p_speed_kmh double precision, p_shuttle_id uuid, p_accuracy_m double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_review_document(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid, p_action text, p_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_review_document(p_tenant_id uuid, p_actor_user_id uuid, p_document_id uuid, p_action text, p_reason text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_set_pin(p_tenant_id uuid, p_phone text, p_pin text, p_pin_token text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_set_pin(p_tenant_id uuid, p_phone text, p_pin text, p_pin_token text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.driver_verify_session(p_session_token uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_verify_session(p_session_token uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.empresa_dashboard(p_tenant_id uuid, p_business_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.empresa_dashboard(p_tenant_id uuid, p_business_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.grant_coupon_internal(p_tenant_id uuid, p_template_id uuid, p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_coupon_internal(p_tenant_id uuid, p_template_id uuid, p_customer_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.identify_customer(p_tenant_id uuid, p_phone text, p_name text, p_email text, p_instagram text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identify_customer(p_tenant_id uuid, p_phone text, p_name text, p_email text, p_instagram text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.is_valid_cnpj(p_cnpj text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_cnpj(p_cnpj text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.is_valid_cpf(p_cpf text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_cpf(p_cpf text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.link_affiliate_by_id(p_tenant_id uuid, p_affiliate_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_affiliate_by_id(p_tenant_id uuid, p_affiliate_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.link_affiliate_customer(p_tenant_id uuid, p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_affiliate_customer(p_tenant_id uuid, p_customer_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_categories(p_tenant_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_categories(p_tenant_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_cities(p_tenant_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_cities(p_tenant_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_customer_coupons(p_tenant_id uuid, p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_customer_coupons(p_tenant_id uuid, p_customer_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_live_vehicles(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_m double precision, p_max_age_s integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_live_vehicles(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_m double precision, p_max_age_s integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_offers(p_tenant_id uuid, p_city text, p_category text, p_lat double precision, p_lng double precision, p_radius_km double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_offers(p_tenant_id uuid, p_city text, p_category text, p_lat double precision, p_lng double precision, p_radius_km double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_shuttle_services(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_shuttle_services(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision) TO service_role;
REVOKE EXECUTE ON FUNCTION public.norm_categoria(p text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.norm_categoria(p text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.normalize_instagram(p_handle text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_instagram(p_handle text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_enqueue(p_tenant_id uuid, p_event text, p_channel text, p_destination text, p_subject text, p_body text, p_customer_id uuid, p_coupon_id uuid, p_booking_ref text, p_provider text, p_status text, p_strict boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_enqueue(p_tenant_id uuid, p_event text, p_channel text, p_destination text, p_subject text, p_body text, p_customer_id uuid, p_coupon_id uuid, p_booking_ref text, p_provider text, p_status text, p_strict boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_mark_failed(p_message_id uuid, p_error_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_mark_failed(p_message_id uuid, p_error_code text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.outbound_mark_sent(p_message_id uuid, p_provider_message_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_mark_sent(p_message_id uuid, p_provider_message_id text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.purge_expired_idempotency_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_idempotency_keys() TO service_role;
REVOKE EXECUTE ON FUNCTION public.referral_convert(p_tenant_id uuid, p_referred_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referral_convert(p_tenant_id uuid, p_referred_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.referral_track(p_tenant_id uuid, p_referral_code text, p_referred_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referral_track(p_tenant_id uuid, p_referral_code text, p_referred_user_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.register_business(p_tenant_slug text, p_name text, p_category text, p_city text, p_phone text, p_email text, p_cnpj text, p_website text, p_logo_url text, p_lat double precision, p_lng double precision, p_internal_code text, p_pin text, p_instagram text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_business(p_tenant_slug text, p_name text, p_category text, p_city text, p_phone text, p_email text, p_cnpj text, p_website text, p_logo_url text, p_lat double precision, p_lng double precision, p_internal_code text, p_pin text, p_instagram text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.shuttle_cancel_reservation(p_tenant_id uuid, p_customer_id uuid, p_reservation_id uuid, p_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shuttle_cancel_reservation(p_tenant_id uuid, p_customer_id uuid, p_reservation_id uuid, p_reason text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.shuttle_create_reservation(p_tenant_id uuid, p_customer_id uuid, p_service_id uuid, p_scheduled_for timestamp with time zone, p_passengers integer, p_notes text, p_contact_phone text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shuttle_create_reservation(p_tenant_id uuid, p_customer_id uuid, p_service_id uuid, p_scheduled_for timestamp with time zone, p_passengers integer, p_notes text, p_contact_phone text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.shuttle_list_customer_reservations(p_tenant_id uuid, p_customer_id uuid, p_status text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shuttle_list_customer_reservations(p_tenant_id uuid, p_customer_id uuid, p_status text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.trg_referral_reward_link() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_referral_reward_link() TO service_role;
REVOKE EXECUTE ON FUNCTION public.try_referral_convert(p_tenant_id uuid, p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_referral_convert(p_tenant_id uuid, p_customer_id uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.validate_and_redeem_coupon(p_tenant_id uuid, p_business_id uuid, p_public_id text, p_raw_token text, p_actor_user_id uuid, p_idempotency_key text, p_short_code text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_redeem_coupon(p_tenant_id uuid, p_business_id uuid, p_public_id text, p_raw_token text, p_actor_user_id uuid, p_idempotency_key text, p_short_code text) TO service_role;

COMMIT;

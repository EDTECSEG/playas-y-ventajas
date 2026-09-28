-- ============================================================
-- Playas y Ventajas - Afiliados (wiring do Modulo 3)
-- ------------------------------------------------------------
-- Complementa modulo3-afiliados.sql: RPCs de consulta/config para
-- a pagina do afiliado e o painel do admin. Nada aqui altera a
-- logica de conversao (referral_convert) do Modulo 3.
--
--   1) affiliate_dashboard      -> perfil do afiliado + numeros
--   2) admin_affiliate_report   -> relatorio geral pelo ADMIN
--   3) admin_get_affiliate_rewards / admin_set_affiliate_rewards
--                                -> config de cupom-premio por tenant
-- ============================================================

-- ------------------------------------------------------------
-- 1) Painel do afiliado (self-service, validado por telefone)
-- ------------------------------------------------------------
-- Publico + seguro: exige p_affiliate_id E p_phone iguais ao banco.
-- Sem telefone certo nao devolve nada. Usa STABLE e leitura direta
-- (chamada com a chave service_role nos handlers).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.affiliate_dashboard(
  p_tenant_id uuid,
  p_affiliate_id uuid,
  p_phone text,
  p_de timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path = public, extensions
AS $function$
  select jsonb_build_object(
    'affiliateId', a.id,
    'name', a.name,
    'phone', a.phone,
    'referralCode', a.referral_code,
    'kind', a.kind,
    'rewardStatus', a.reward_status,
    'createdAt', a.created_at,
    'totalReferrals', count(r.id),
    'converted', count(r.id) filter (where r.status = 'converted'),
    'pending', count(r.id) filter (where r.status = 'pending'),
    'rewardCoupons', count(r.id) filter (where r.reward_coupon_id is not null),
    'referrals', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'status', r.status,
        'convertedAt', r.converted_at,
        'createdAt', r.created_at,
        'referredName', u.name,
        'referredPhone', u.phone
      ) order by r.created_at desc
    ) filter (where r.id is not null), '[]'::jsonb)
  )
  from public.affiliates a
  left join public.referrals r
         on r.affiliate_id = a.id
        and (p_de is null or r.created_at >= p_de)
        and (p_ate is null or r.created_at < p_ate)
  left join public.users u on u.id = r.referred_user_id
  where a.id = p_affiliate_id
    and a.tenant_id = p_tenant_id
    and a.phone = p_phone
  group by a.id;
$function$;

-- ------------------------------------------------------------
-- 2) Relatorio geral de afiliados (ADMIN / SUPER_ADMIN)
-- ------------------------------------------------------------
-- Equivale ao affiliate_report do Modulo 3, mas aceita ADMIN
-- tambem (o original so libera SUPER_ADMIN).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_affiliate_report(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_de timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path = public, extensions
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

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'affiliateId', a.id,
      'name', a.name,
      'phone', a.phone,
      'referralCode', a.referral_code,
      'kind', a.kind,
      'rewardStatus', a.reward_status,
      'createdAt', a.created_at,
      'totalReferrals', count(r.id),
      'converted', count(r.id) filter (where r.status = 'converted'),
      'pending', count(r.id) filter (where r.status = 'pending')
    ) order by a.created_at desc
  ), '[]'::jsonb)
  into v_out
  from public.affiliates a
  left join public.referrals r
         on r.affiliate_id = a.id
        and (p_de is null or r.created_at >= p_de)
        and (p_ate is null or r.created_at < p_ate)
  where a.tenant_id = p_tenant_id
  group by a.id;

  return v_out;
end $function$;

-- ------------------------------------------------------------
-- 3) Config de cupons-premio (rewards) padrao e boas-vindas
-- ------------------------------------------------------------
-- Uso pelo admin: escolhe qual template vira premio do afiliado e
-- qual vira boas-vindas do indicado. Sem config, a indicacao ainda
-- converte (apenas sem cupom) - fail-open, como no Modulo 3.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_affiliate_rewards(
  p_tenant_id uuid,
  p_actor_user_id uuid
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path = public, extensions
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_affiliate_rewards(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_affiliate_reward_template_id uuid DEFAULT NULL,
  p_welcome_template_id uuid DEFAULT NULL,
  p_require_first_claim boolean DEFAULT true
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
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
end $function$;

REVOKE EXECUTE ON FUNCTION public.affiliate_dashboard(uuid, uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_affiliate_report(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_get_affiliate_rewards(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_set_affiliate_rewards(uuid, uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
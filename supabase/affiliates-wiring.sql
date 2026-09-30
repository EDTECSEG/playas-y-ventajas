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
--
-- Devolve duas visoes do MESMO conjunto de linhas, montadas na mesma
-- agregacao:
--   referrals -> a lista simples de sempre (quem indicou, status, data)
--   resgates   -> o extrato: qual cupom a pessoa pegou, em qual
--                estabelecimento, com quanto de desconto e se chegou a
--                ser usado no balcao
--
-- Duas semanticas que confundem quem le isso:
--   - converted_at e a conversao da indicacao, que dispara no CLAIM
--     (a pessoa pegou o cupom), nao na validacao no caixa. A recompensa do
--     afiliado e creditada nesse momento.
--   - o resgate no balcao e coupons.validated_at, que pode ser muito depois
--     ou nunca acontecer. Por isso o extrato mostra as duas datas e o status
--     do cupom, em vez de chamar o cupom de "resgatado" quando so foi pego.
--
-- O cupom da pessoa e o PRIMEIRO emitido depois da indicacao: e o que
-- disparou a conversao. Filtrar por status = 'VALIDATED' daria a resposta
-- errada, porque mostraria o cupom de outra visita e esconderia o cupom
-- pego e nunca usado.
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
  -- Uma unica CTE monta a linha, ja com o cupom da pessoa. As contagens e os
  -- dois jsonb_agg sao lidos DEPOIS, no mesmo nivel: nada de contagem dentro
  -- de agregacao, que e o que fez admin_affiliate_report estourar com 42803.
  with indicacoes as (
    select r.id,
           r.status,
           r.created_at,
           r.converted_at,
           r.reward_coupon_id,
           u.name as referred_name,
           u.phone as referred_phone,
           c.public_id,
           c.status as coupon_status,
           c.issued_at,
           c.validated_at,
           t.title,
           t.benefit_type,
           t.benefit_value,
           biz.name as business_name,
           premio.public_id as reward_public_id
    from public.referrals r
    left join public.users u on u.id = r.referred_user_id
    left join lateral (
      select co.public_id, co.status, co.issued_at, co.validated_at,
             co.template_id, co.business_id
      from public.coupons co
      where co.customer_id = r.referred_user_id
        and co.issued_at >= r.created_at
      order by co.issued_at asc
      limit 1
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
    'affiliateId', a.id,
    'name', a.name,
    'phone', a.phone,
    'referralCode', a.referral_code,
    'kind', a.kind,
    'rewardStatus', a.reward_status,
    'createdAt', a.created_at,
    'totalReferrals', count(i.id),
    'converted', count(i.id) filter (where i.status = 'converted'),
    'pending', count(i.id) filter (where i.status = 'pending'),
    'rewardCoupons', count(i.id) filter (where i.reward_coupon_id is not null),
    'cuponsPegos', count(i.id) filter (where i.public_id is not null),
    'cuponsResgatados', count(i.id) filter (where i.validated_at is not null),
    'referrals', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'status', i.status,
        'convertedAt', i.converted_at,
        'createdAt', i.created_at,
        'referredName', i.referred_name,
        'referredPhone', i.referred_phone
      ) order by i.created_at desc
    ) filter (where i.id is not null), '[]'::jsonb),
    'resgates', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'status', i.status,
        'indicado', i.referred_name,
        'telefone', i.referred_phone,
        'indicadoEm', i.created_at,
        'convertidoEm', i.converted_at,
        'cupom', i.title,
        'cupomCodigo', i.public_id,
        'cupomStatus', i.coupon_status,
        'beneficioTipo', i.benefit_type,
        'beneficioValor', i.benefit_value,
        'estabelecimento', i.business_name,
        'cupomEm', i.issued_at,
        'resgatadoEm', i.validated_at,
        'premioCodigo', i.reward_public_id
      ) order by coalesce(i.validated_at, i.issued_at, i.created_at) desc
    ) filter (where i.id is not null), '[]'::jsonb)
  )
  from public.affiliates a
  left join indicacoes i on true
  where a.id = p_affiliate_id
    and a.tenant_id = p_tenant_id
    -- Compara os DIGITOS, nao o texto: o telefone volta do navegador como a
    -- pessoa digitou e a igualdade exata fazia o painel devolver vazio so
    -- por causa da mascara. phone_digits e coluna gerada pelo Postgres.
    and a.phone_digits = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
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

  -- BUG (setembro/2026): as contagens ficavam DENTRO do jsonb_agg(). Postgres
  -- nao aninha agregacao (ERROR 42803), a RPC estourava em toda chamada e o
  -- admin mostrava "nenhum afiliado cadastrado" mesmo com o cadastro no banco.
  -- As contagens vao numa CTE e o jsonb_agg roda por fora, num nivel so.
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
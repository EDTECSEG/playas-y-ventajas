-- ============================================================
-- Playas y Ventajas - Modulo 3: Afiliados e indicacoes
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR. Idempotente: pode rodar varias vezes.
-- RODE DEPOIS do modulo1 (que cria a tabela drivers).
--
-- Conceito:
--   affiliate  = um parceiro (pode ser um cliente, um motorista ou uma
--                empresa) que divulga a plataforma e ganha por indicacao.
--   referral   = o vinculo "afiliado indicou -> cliente se cadastrou".
--                Guardamos quem indicou E quem foi indicado.
--   benefit    = o premio do afiliado (cupom) e o premio do indicado
--                (cupom de boas-vindas). Ambos creditados quando a
--                indicacao vira um resgate valido.
--
-- Fluxo:
--   1) POST /.netlify/functions/affiliates  {name, phone, email}
--      -> cria o afiliado e devolve referral_code (ex.: "MARIA-7F3A")
--   2) O afiliado divulga: /?ref=MARIA-7F3A
--   3) O novo cliente entra com esse codigo. A indicacao e registrada
--      em referrals com status 'pending'.
--   4) Quando o indicado RESGATA um cupom pela 1a vez, a indicacao vira
--      'converted' e os dois recebem o cupom de premio.
--
-- Decisao: o premio e creditado na CONVERSAO (primeiro resgate), e nao
-- no cadastro. Isso evita desperdicio ("cadastro falso" inflando numero de
-- afiliados) e so paga quem realmente trouxe cliente ativo.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabela de afiliados
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.affiliates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text NOT NULL,
  email           text,
  -- Codigo curto de divulgacao. Unico por tenant.
  referral_code   text NOT NULL,
  -- Papel do afiliado (informativo, para segmentar relatorios)
  -- 'customer' = cliente comum divulgando
  -- 'driver'   = motorista divulgando
  -- 'business' = empresa parceira divulgando
  kind            text NOT NULL DEFAULT 'customer'
                    CHECK (kind IN ('customer','driver','business')),
  -- Vinculos opcionais
  customer_id     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  driver_id       uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  business_id     uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  -- Bonus: se 'active', o afiliado recebe cupom de premio a cada
  -- conversao valida. 'paused' = nao paga mais.
  reward_status   text NOT NULL DEFAULT 'active'
                    CHECK (reward_status IN ('active','paused')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliates_code_uniq UNIQUE (tenant_id, referral_code)
);

CREATE INDEX IF NOT EXISTS affiliates_tenant_idx
  ON public.affiliates (tenant_id);
CREATE INDEX IF NOT EXISTS affiliates_kind_idx
  ON public.affiliates (tenant_id, kind);

-- ------------------------------------------------------------
-- 2) Tabela de indicacoes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  affiliate_id    uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  -- Quem foi indicado (o novo cliente). Unico por tenant: um cliente
  -- so pode ser indicado uma vez.
  referred_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Codigo usado na divulgacao (copia, para auditoria)
  referral_code   text NOT NULL,
  -- 'pending'   = cadastro feito, ainda nao resgatou nada
  -- 'converted' = resgatou um cupom (conversao paga)
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','converted')),
  -- Cupom de premio que o afiliado ganhou (se houver)
  reward_coupon_id uuid,
  -- Cupom de boas-vindas que o indicado ganhou (se houver)
  welcome_coupon_id uuid,
  converted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Um cliente indicado so uma vez por tenant (evita multi-credito)
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referred_uniq
  ON public.referrals (tenant_id, referred_user_id)
  WHERE referred_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referrals_affiliate_idx
  ON public.referrals (affiliate_id, status);
CREATE INDEX IF NOT EXISTS referrals_pending_idx
  ON public.referrals (tenant_id)
  WHERE status = 'pending';

-- ------------------------------------------------------------
-- 3) Cupom de premio (boas-vindas / reward)
-- ------------------------------------------------------------
-- Em vez de criar templates novos, reutilizamos os cupons que a
-- plataforma ja tem. A empresa/admin define QUAL template serve de
-- premio. Guardamos essa escolha em affiliate_rewards.
-- Se nao houver template configurado, a indicacao continua valendo
-- (vira 'converted') mas sem cupom: o sistema nunca quebra.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.affiliate_rewards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Cupom que o AFILIADO recebe por cada indicacao convertida
  affiliate_reward_template_id  uuid REFERENCES public.coupon_templates(id) ON DELETE SET NULL,
  -- Cupom que o INDICADO (novo cliente) recebe de boas-vindas
  welcome_template_id           uuid REFERENCES public.coupon_templates(id) ON DELETE SET NULL,
  -- Se true, o indicado precisa resgatar antes de ser considerado
  -- convertido (default true = so conta indicacao que usa a plataforma)
  require_first_claim           boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Uma config por tenant
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_rewards_tenant_uniq
  ON public.affiliate_rewards (tenant_id);

-- ------------------------------------------------------------
-- 4) RPC: cadastrar afiliado
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.affiliate_register(uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.affiliate_register(
  p_tenant_id uuid,
  p_name text,
  p_phone text,
  p_email text DEFAULT NULL,
  p_kind text DEFAULT 'customer',
  p_referral_code text DEFAULT NULL   -- codigo customized, opcional
)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_aff public.affiliates%rowtype;
  v_code text;
  v_base text;
begin
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
    'shareUrl', '/?ref=' || v_aff.referral_code
  );
exception
  when unique_violation then
    -- codigo ja existe: gera outro automaticamente e tenta de novo
    v_code := v_code || upper(encode(gen_random_bytes(1), 'hex'));
    insert into public.affiliates (tenant_id, name, phone, email, kind, referral_code)
    values (p_tenant_id, p_name, p_phone, p_email, p_kind, v_code)
    returning * into v_aff;
    return jsonb_build_object(
      'affiliateId', v_aff.id,
      'referralCode', v_aff.referral_code,
      'shareUrl', '/?ref=' || v_aff.referral_code
    );
end $function$
;

-- ------------------------------------------------------------
-- 5) RPC: registrar indicacao (novo cliente entra com ?ref=CODIGO)
-- ------------------------------------------------------------
-- Chamada pelo endpoint publico de registro. Se o codigo nao existir,
-- nao ha erro: a pessoa segue se cadastrando normalmente (fail-open,
-- porque uma indicacao nunca deve bloquear um cadastro).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.referral_track(uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.referral_track(
  p_tenant_id uuid,
  p_referral_code text,
  p_referred_user_id uuid
)
 RETURNS void
 LANGUAGE plpgsql
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

  insert into public.referrals (tenant_id, affiliate_id, referred_user_id, referral_code, status)
  values (p_tenant_id, v_aff.id, p_referred_user_id, v_aff.referral_code, 'pending');
end $function$
;

-- ------------------------------------------------------------
-- 6) Conversao: chamado quando o indicado resgata o 1o cupom
-- ------------------------------------------------------------
-- Credita o cupom de premio pro afiliado e o de boas-vindas pro
-- indicado. Tudo numa transacao (a function e atomica). Se nao houver
-- template de premio configurado, so marca como converted.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.referral_convert(uuid, uuid);

CREATE OR REPLACE FUNCTION public.referral_convert(
  p_tenant_id uuid,
  p_referred_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
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

-- ------------------------------------------------------------
-- 7) Helper: concessao interna de cupom
-- ------------------------------------------------------------
-- Fatora o INSERT de coupons (mesmo formato do claim_coupon) para
-- ser usado por referral_convert sem duplicar codigo. Se o template
-- nao existir/estiver inativo, devolve null (nao quebra a indicacao).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.grant_coupon_internal(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.grant_coupon_internal(
  p_tenant_id uuid,
  p_template_id uuid,
  p_customer_id uuid
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
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

  if v_template.total_stock is not null and v_template.issued_count >= v_template.total_stock then
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

  update coupon_templates set issued_count = issued_count + 1 where id = p_template_id;
  return v_coupon_id;
end $function$
;

-- ------------------------------------------------------------
-- 8) RLS (as functions usam service_role, que ignora RLS)
-- ------------------------------------------------------------
ALTER TABLE public.affiliates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_rewards ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 9) Relatorio de afiliados (para o admin)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.affiliate_report(uuid, uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.affiliate_report(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_de timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_actor users%rowtype;
  v_de timestamptz;
  v_ate timestamptz;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.role <> 'SUPER_ADMIN' then
    raise exception 'FORBIDDEN';
  end if;

  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),
    'totals', (
      select jsonb_build_object(
        'affiliates',     (select count(*) from affiliates a where a.tenant_id = p_tenant_id),
        'referrals',      (select count(*) from referrals r where r.tenant_id = p_tenant_id and r.created_at >= v_de),
        'converted',      (select count(*) from referrals r where r.tenant_id = p_tenant_id and r.status='converted' and r.converted_at >= v_de),
        'pending',        (select count(*) from referrals r where r.tenant_id = p_tenant_id and r.status='pending')
      )
    ),
    'ranking', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'affiliateId', a.affiliate_id,
          'name',        aff.name,
          'kind',        aff.kind,
          'referralCode', aff.referral_code,
          'converted',   a.conversoes,
          'rewardStatus', aff.reward_status
        ) order by a.conversoes desc
      ), '[]'::jsonb)
      from (
        select affiliate_id, count(*) as conversoes
        from referrals
        where tenant_id = p_tenant_id and status = 'converted'
          and converted_at >= v_de
        group by affiliate_id
      ) a
      join affiliates aff on aff.id = a.affiliate_id
    )
  );
end $function$
;

-- ------------------------------------------------------------
-- 10) Fim do Modulo 3
-- ------------------------------------------------------------
-- FALTA: ligar referral_convert na claim_coupon (ver modulo3b).
-- A claim_coupon em producao NAO deve ser reescrita a mao aqui;
-- o hook e feito em modulo3b-com-hook-claim.sql.

-- ============================================================
-- Playas y Ventajas - Offers v3: filtros por atividade e raio +
-- destaque de OFERTA por cupom (com validade)
-- ------------------------------------------------------------
-- Depende de offers-filters-and-featured.sql (list_cities,
-- featured_rank, admin_featured_ranks, admin_set_featured e
-- indice espacial) aplicado antes.
--
-- O que esta migracao entrega:
--   1) enabled_offers_t >= coluna `featured_until` em
--      coupon_templates + indice parcial. Empresa/ADMIN marcam a
--      oferta como "patrocinada" ate uma data (auto-expira).
--   2) norm_categoria(): normaliza acento/caixa para que
--      'Servico', 'SERVIÇO' e 'servico' casem entre si.
--   3) list_categories(): as categorias com oferta ativa, para
--      os chips do app cliente.
--   4) list_offers v3: ordena primeiro por oferta destacada,
--      depois featured_rank da empresa, depois distancia; devolve
--      featured/featuredUntil/distanceKm.
--   5) business_set_coupon_featured (self-service: so o dono do
--      template) e admin_set_coupon_featured (override/limpeza).
--   6) business_update_own v10: empresarial passa a editar a
--      propria `category`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Destaque por CUPOM com validade
-- ------------------------------------------------------------
ALTER TABLE public.coupon_templates
  ADD COLUMN IF NOT EXISTS featured_until timestamptz;

-- Apenas ofertas com data marcada; ofertas normais nao entram no indice.
CREATE INDEX IF NOT EXISTS idx_coupon_templates_featured_until
  ON public.coupon_templates (tenant_id, featured_until DESC)
  WHERE featured_until IS NOT NULL;

-- ------------------------------------------------------------
-- 2) Normalizacao compartilhada de categoria
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.norm_categoria(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public, extensions
AS $function$
  select translate(lower(coalesce(p, '')), 'áàâãäåéèêëíìîïóòôõöúùûüç', 'aaaaaaeeeeiiiiooooouuuuc');
$function$;

-- ------------------------------------------------------------
-- 3) Categorias com oferta ativa (chips do cliente)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_categories(p_tenant_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path = public, extensions
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
      and (t.total_stock is null or t.issued_count < t.total_stock)
      and (t.valid_until is null or t.valid_until > now())
      and b.category is not null and b.category <> ''
  ) n;
$function$;

-- ------------------------------------------------------------
-- 4) list_offers v3 (destacado -> featured_rank -> distancia)
-- ------------------------------------------------------------
-- Mantem a antiga assinatura de 1 argumento eliminada: garante que
-- nunca sobra uma list_offers(uuid) velha quebrando o handler.
DROP FUNCTION IF EXISTS public.list_offers(uuid);

CREATE OR REPLACE FUNCTION public.list_offers(
  p_tenant_id uuid,
  p_city text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_radius_km double precision DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path = public, extensions
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
    and (t.total_stock is null or t.issued_count < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and (p_city is null or lower(b.city) = lower(p_city))
    and (p_category is null or public.norm_categoria(b.category) = public.norm_categoria(p_category))
    and (p_radius_km is null or p_lat is null or p_lng is null
         or (b.location is not null
             and st_dwithin(b.location, st_makepoint(p_lng, p_lat)::geography, p_radius_km * 1000)));
$function$;

-- ------------------------------------------------------------
-- 5) Destaque por cupom: self-service da empresa + admin
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_set_coupon_featured(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid,
  p_until timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  -- Self-service: apenas o dono do template destaca o proprio cupom.
  -- Para limpar, a empresa envia p_until = null.
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
end $function$;

CREATE OR REPLACE FUNCTION public.admin_set_coupon_featured(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid,
  p_until timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
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
end $function$;

REVOKE EXECUTE ON FUNCTION public.business_set_coupon_featured(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_set_coupon_featured(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6) business_update_own v10: empresa edita a propria categoria
-- ------------------------------------------------------------
-- Remove a assinatura da v9 (9 argumentos) e sobe a versao com p_category.
DROP FUNCTION IF EXISTS public.business_update_own(uuid, uuid, text, text, text, text, text, double precision, double precision);

CREATE OR REPLACE FUNCTION public.business_update_own(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_city text,
  p_logo_url text,
  p_category text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path = public, extensions
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
    location = case when p_lat is not null and p_lng is not null
                    then st_makepoint(p_lng, p_lat)::geography
                    else location end
  where id = v_actor.business_id and tenant_id = p_tenant_id;
end $function$;
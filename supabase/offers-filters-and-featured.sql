-- ============================================================
-- Playas y Ventajas - Filtros da lista de ofertas + Destaque
-- ============================================================
-- 1) Nova coluna `featured_rank` em businesses: quanto MAIOR o
--    valor, mais para o topo a empresa aparece na lista de
--    ofertas do cliente (0 = normal, sem destaque).
-- 2) list_offers v2: aceita p_city, p_category, p_lat, p_lng,
--    p_radius_km (filtros COMPOSTOS) e ordena por destaque
--    (depois, por distância quando raio informado).
-- 3) Novo RPC list_cities: devolve as cidades com oferta ativa
--    (para os chips de filtro na tela do cliente).
--
-- Como usar (SQL Editor do Supabase): rode o arquivo inteiro.
-- ============================================================

-- Coluna de destaque (rank; 0 = normal, maior = sobe no topo)
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS featured_rank integer NOT NULL DEFAULT 0;

-- Indice para ordenacao por destaque + raio
CREATE INDEX IF NOT EXISTS idx_businesses_featured_rank
  ON public.businesses (featured_rank DESC, tenant_id);

-- Indice espacial (se ainda nao existir) para filtro por raio
CREATE INDEX IF NOT EXISTS idx_businesses_location_gist
  ON public.businesses USING gist (location);

-- ------------------------------------------------------------
-- Destaque: admin consulta/seta o featured_rank de cada negocio
-- (RPCs novas versionadas; nao tocam nas RPCs admin ja existentes)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_featured_ranks(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public
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

CREATE OR REPLACE FUNCTION public.admin_set_featured(
  p_tenant_id uuid, p_actor_user_id uuid, p_business_id uuid, p_featured_rank integer
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public
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

-- ------------------------------------------------------------
-- RPC: cidades que possuem oferta publica ativa
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_cities(p_tenant_id uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(array_agg(distinct b.city order by b.city), '{}'::text[])
  from coupon_templates t
  join campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or t.issued_count < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and b.city is not null
    and b.city <> '';
$function$
;

-- ------------------------------------------------------------
-- list_offers v2: filtros compostos + ordenacao por destaque
-- ------------------------------------------------------------
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
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'templateId', t.id, 'title', t.title, 'benefitType', t.benefit_type, 'benefitValue', t.benefit_value,
      'businessId', b.id, 'businessName', b.name, 'category', b.category, 'city', b.city,
      'imageUrl', t.image_url, 'logoUrl', b.logo_url, 'featuredRank', b.featured_rank,
      'distanceKm',
        case when p_lat is not null and b.location is not null
             then round((st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) / 1000)::numeric, 2)
             else null end
    ) order by
      b.featured_rank desc,
      case when p_lat is not null and b.location is not null
           then st_distance(b.location, st_makepoint(p_lng, p_lat)::geography) else null end asc,
      b.name asc,
      t.title asc
  ), '[]'::jsonb)
  from coupon_templates t
  join campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or t.issued_count < t.total_stock)
    and (t.valid_until is null or t.valid_until > now())
    and (p_city is null or lower(b.city) = lower(p_city))
    and (p_category is null or b.category = p_category)
    and (p_radius_km is null or p_lat is null or p_lng is null
         or (b.location is not null
             and st_dwithin(b.location, st_makepoint(p_lng, p_lat)::geography, p_radius_km * 1000)));
$function$
;
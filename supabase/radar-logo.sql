-- ============================================================
-- Playas y Ventajas - Radar devolve a logo da empresa
-- ============================================================
-- Objetivo: o mapa do cliente exibe a logo da empresa no marcador
-- em vez do círculo amarelo/verde. O RPC find_nearby_businesses
-- passa a retornar também logoUrl da businesses.
--
-- Como usar (SQL Editor do Supabase): rode o arquivo inteiro.
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_nearby_businesses(p_tenant_id uuid, p_lat double precision, p_lng double precision, p_radius_km double precision DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare v_result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.name, 'category', b.category, 'city', b.city,
    'lat', ST_Y(b.location::geometry), 'lng', ST_X(b.location::geometry),
    'logoUrl', b.logo_url,
    'distanceKm', round((ST_Distance(b.location, ST_MakePoint(p_lng,p_lat)::geography) / 1000)::numeric, 2),
    'hasActiveOffer', exists(select 1 from coupon_templates t where t.business_id=b.id and (t.total_stock is null or t.issued_count < t.total_stock)),
    'offerImageUrl', (select t.image_url from coupon_templates t where t.business_id=b.id and (t.total_stock is null or t.issued_count < t.total_stock) and t.image_url is not null limit 1)
  ) order by ST_Distance(b.location, ST_MakePoint(p_lng,p_lat)::geography)), '[]'::jsonb)
  into v_result from businesses b
  where b.tenant_id = p_tenant_id and b.is_active and b.location is not null
    and ST_DWithin(b.location, ST_MakePoint(p_lng,p_lat)::geography, p_radius_km * 1000);
  return v_result;
end $function$
;
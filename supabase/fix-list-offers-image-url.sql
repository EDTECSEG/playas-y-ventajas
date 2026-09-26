-- list_offers com filtros (6 argumentos) tinha perdido o imageUrl que a
-- sobrecarga de 1 argumento retorna. Sem ele, o handler de ofertas era
-- obrigado a fazer uma segunda consulta em coupon_templates so para montar
-- o mesmo dado que o Postgres ja tinha em maos, dobrando as idas ao
-- PostgREST por requisicao. Sob concorrencia essa segunda ida travava e a
-- tela do cliente ficava vazia sem mensagem de erro.
-- Redefinicao identica a de offers-filters-and-featured.sql, com imageUrl de volta.

-- Os DEFAULTs sao obrigatorios: CREATE OR REPLACE nao aceita remove-los de
-- uma funcao existente (42P13), e remover a funcao antes deixaria o endpoint
-- de ofertas sem RPC no intervalo entre o DROP e o CREATE.
CREATE OR REPLACE FUNCTION public.list_offers(
  p_tenant_id uuid,
  p_city text DEFAULT NULL::text,
  p_category text DEFAULT NULL::text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_radius_km double precision DEFAULT NULL::double precision
)
RETURNS jsonb
LANGUAGE sql
AS $$
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'offerId', t.id, 'title', t.title, 'benefitType', t.benefit_type,
        'benefitValue', t.benefit_value, 'businessId', b.id,
        'businessName', b.name, 'category', b.category, 'city', b.city,
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
$$;

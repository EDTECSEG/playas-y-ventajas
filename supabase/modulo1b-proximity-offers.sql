-- ============================================================
-- Playas y Ventajas - Modulo 1b: Cupom por proximidade
-- ------------------------------------------------------------
-- RODE DEPOIS do modulo1-motoristas-translado-proximity.sql
-- (ele cria as colunas requires_proximity_m / proximity_point).
--
-- Objetivo: um cupom so aparece para o cliente quando ele chega
-- perto do ponto (ex.: quiosque de praia com cupom de 15% OFF).
--
-- DECISAO DE DESIGN IMPORTANTE:
-- A funcao list_offers em PRODUCAO hoje e uma versao que NAO devolve
-- imageUrl (verificado em 25/09/2026). Este arquivo NAO reescreve a
-- list_offers: faz-lo derrubaria a camada de enriquecimento comOfferImages
-- que esta no offers.js. Em vez disso, criamos list_offers_public, que
-- e a list_offers + regra de proximidade, e vamos apontar a function
-- HTTP para ela num passo separado.
--
-- A regra de proximidade:
--   cupom SEM proximity_point  -> sempre visivel (comportamento atual)
--   cupom COM proximity_point  -> visivel so se
--        (cliente enviou lat/lng) E st_dwithin(cliente, ponto, raio)
--   Se o cliente NAO enviou lat/lng (sem permissao de localizacao),
--   cupons com proximidade NAO aparecem. Fail-closed: e melhor esconder
--   um cupom do que expor um cupom que exige presenca.
-- ============================================================

-- ------------------------------------------------------------
-- 1) list_offers_public: list_offers + filtro de proximidade
-- ------------------------------------------------------------
-- Assinatura identica a list_offers v2 (6 params) para ser drop-in.
DROP FUNCTION IF EXISTS public.list_offers_public(uuid, text, text, double precision, double precision, double precision);

CREATE OR REPLACE FUNCTION public.list_offers_public(
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
      'offerId', t.id,
      'templateId', t.id,
      'title', t.title,
      'benefitType', t.benefit_type,
      'benefitValue', t.benefit_value,
      'businessId', b.id,
      'businessName', b.name,
      'category', b.category,
      'city', b.city,
      'logoUrl', b.logo_url,
      'featuredRank', b.featured_rank,
      'imageUrl', t.image_url,
      -- sinaliza o cliente que o cupom e "so aqui perto"
      'requiresProximity', (t.proximity_point is not null),
      'proximityM', t.requires_proximity_m,
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
             and st_dwithin(b.location, st_makepoint(p_lng, p_lat)::geography, p_radius_km * 1000)))
    -- >>> REGRA DE PROXIMIDADE <<<
    and (
      -- cupom normal (sem ponto): sempre visivel
      t.proximity_point is null
      or (
        -- cupom por proximidade: exige que o cliente tenha enviado lat/lng
        p_lat is not null and p_lng is not null
        -- ...e que esteja dentro do raio configurado no cupom
        and st_dwithin(
          t.proximity_point,
          st_makepoint(p_lng, p_lat)::geography,
          t.requires_proximity_m
        )
      )
    );
$function$
;

-- ------------------------------------------------------------
-- 2) RPC de apoio: uma empresa "marca" um cupom como por proximidade
-- ------------------------------------------------------------
-- Parametros em metros (0 ou NULL = cupom normal, visivel sempre).
-- owner check: so a dona do cupom pode alterar a regra de proximidade.
DROP FUNCTION IF EXISTS public.set_coupon_proximity(uuid, uuid, uuid, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.set_coupon_proximity(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_radius_m integer DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_actor users%rowtype;
  v_tenant uuid;
begin
  -- resolve o tenant do cupom
  select t.tenant_id into v_tenant
  from coupon_templates t
  where t.id = p_template_id;

  if v_tenant is null then
    raise exception 'TEMPLATE_NOT_FOUND';
  end if;
  if v_tenant <> p_tenant_id then
    raise exception 'FORBIDDEN';
  end if;

  -- ator precisa estar no mesmo tenant e ser dono (business_id) do cupom
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  if not exists (
    select 1 from coupon_templates t
    where t.id = p_template_id and t.business_id = v_actor.business_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  if p_radius_m is null or p_radius_m <= 0 or p_lat is null or p_lng is null then
    -- cupom normal: limpa a regra
    update coupon_templates
    set requires_proximity_m = null,
        proximity_point = null
    where id = p_template_id and tenant_id = p_tenant_id;
  else
    if p_radius_m > 5000 then
      raise exception 'RADIUS_TOO_BIG';
    end if;
    update coupon_templates
    set requires_proximity_m = p_radius_m,
        proximity_point = st_makepoint(p_lng, p_lat)::geography
    where id = p_template_id and tenant_id = p_tenant_id;
  end if;
end $function$
;

-- ------------------------------------------------------------
-- 3) RLS nestas tabelas (as functions usam service_role, que ignora RLS;
--    RLS ligado e defesa em profundidade se alguem expoe com anon key)
-- ------------------------------------------------------------
ALTER TABLE public.drivers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shuttle_services    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_positions   ENABLE ROW LEVEL SECURITY;

-- Sem policies intencionais: com RLS ligado e sem policy, o anon/authenticated
-- nao le nem escreve nada. Todo acesso passa pelas functions com service_role.
-- (mesmo padrao do security-hardening.sql, secao 2)

-- ------------------------------------------------------------
-- 4) Fim do Modulo 1b
-- ------------------------------------------------------------
-- Depois de rodar, valide:
--   select * from list_offers_public('0dc57eeb-46c8-47ac-aad4-640d9d59e7b9');
-- deve retornar as 15 ofertas de sempre (nenhuma tem proximity_point ainda).

-- ------------------------------------------------------------
-- Empresa: atualizar a própria localização (lat/lng)
-- 1) business_get_own passa a devolver lat/lng da coluna `location`
-- 2) business_update_own passa a aceitar p_lat/p_lng
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare v_actor users%rowtype; v_business businesses%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.business_id is null then raise exception 'FORBIDDEN'; end if;
  select * into v_business from businesses where id=v_actor.business_id;
  return jsonb_build_object('name',v_business.name,'phone',v_business.phone,'email',v_business.email,
    'city',v_business.city,'category',v_business.category,'cnpj',v_business.cnpj,'website',v_business.website,
    'logoUrl',v_business.logo_url,
    'lat', case when v_business.location is not null then ST_Y(v_business.location::geometry) else null end,
    'lng', case when v_business.location is not null then ST_X(v_business.location::geometry) else null end);
end $function$
;

DROP FUNCTION IF EXISTS public.business_update_own(uuid, uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.business_update_own(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_city text,
  p_logo_url text,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.business_id is null then raise exception 'FORBIDDEN'; end if;
  update businesses set
    name=coalesce(p_name,name),
    phone=coalesce(p_phone,phone),
    email=coalesce(p_email,email),
    city=coalesce(p_city,city),
    logo_url=coalesce(p_logo_url,logo_url),
    location = case when p_lat is not null and p_lng is not null
                    then ST_MakePoint(p_lng, p_lat)::geography
                    else location end
    where id=v_actor.business_id and tenant_id=p_tenant_id;
end $function$
;
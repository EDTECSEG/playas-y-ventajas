-- ===========================================================================
-- ROLLBACK da p9 - Contato publico da empresa
-- ===========================================================================
-- O QUE ESTE ARQUIVO DESFAZ:
--   - devolve as 4 funcoes de escrita (register_business, admin_create_business,
--     admin_update_business, business_update_own) as assinaturas antigas;
--   - volta business_get_own, list_offers e list_customer_coupons aos corpos
--     anteriores;
--   - derruba business_public_card e normalize_instagram.
--
-- O QUE ESTE ARQUIVO NAO DESFAZ, DE PROPOSITO:
--   - A COLUNA businesses.instagram CONTINUA NO BANCO.
--     Depois que a p9 estiver no ar e as empresas preencherem o perfil, um
--     rollback que rodasse `drop column` apagaria dado REAL digitado por
--     terceiros. A coluna fica orfa e inofensiva: nenhuma funcao a le, nenhuma
--     tela a mostra, e a p9 reaplicada volta a usa-la. Este e o mesmo criterio
--     do rollback da p6, que tambem deixa as colunas de CPF/CNPJ no lugar.
--   - Se a p9 for reaplicada depois, ela cria a coluna com `if not exists` e
--     recria as funcoes: nao ha conflito.
--
-- ORDEM DE VOLTA: nenhuma. Este arquivo reverte a p9 sozinho.
--
-- ATENCAO - ACL (Regra 4 do AGENTS.md):
--   As 4 funcoes de escrita sao DROP + CREATE aqui tambem, entao nascem com o
--   default do schema, que e EXECUTE para PUBLIC (e anon/authenticated sao
--   membros de PUBLIC). Cada revoke/grant esta no lugar certo, logo abaixo da
--   criacao da funcao correspondente. Um rollback e justamente o caminho usado
--   quando algo deu errado: e o pior momento para deixar uma funcao de escrita
--   aberta.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. As 4 de escrita, de volta as assinaturas antigas
-- ---------------------------------------------------------------------------
drop function if exists public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text, text);
create function public.register_business(
  p_tenant_slug text,
  p_name text,
  p_category text,
  p_city text,
  p_phone text,
  p_email text,
  p_cnpj text,
  p_website text,
  p_logo_url text,
  p_lat double precision,
  p_lng double precision,
  p_internal_code text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path to public, extensions
as $function$
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

  INSERT INTO businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url)
  VALUES (v_tenant.id, trim(p_name), coalesce(p_category,'servico'), p_city, p_phone, p_email,
          CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN ST_MakePoint(p_lng,p_lat)::geography ELSE NULL END,
          v_owner_id, 'FREE', 'TRIAL', p_cnpj, p_website, p_logo_url)
  RETURNING id INTO v_business_id;

  UPDATE users SET business_id = v_business_id WHERE id = v_owner_id;

  RETURN jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id, 'internalCode', p_internal_code);
END $function$
;
revoke execute on function public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text) from public, anon, authenticated;
grant  execute on function public.register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text) to service_role;

drop function if exists public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text, text);
create function public.admin_create_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_category text,
  p_city text,
  p_phone text,
  p_email text,
  p_lat double precision,
  p_lng double precision,
  p_owner_internal_code text,
  p_owner_pin text,
  p_billing_plan text,
  p_cnpj text default null::text,
  p_website text default null::text,
  p_logo_url text default null::text
)
returns jsonb
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype; v_owner_id uuid; v_business_id uuid;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  if length(p_owner_pin) < 6 then raise exception 'WEAK_PIN: minimo de 6 caracteres'; end if;

  select id into v_owner_id from users where tenant_id = p_tenant_id and internal_code = p_owner_internal_code;
  if not found then
    insert into users (tenant_id, internal_code, role, pin_hash)
      values (p_tenant_id, p_owner_internal_code, 'MERCHANT', encode(digest(p_owner_pin,'sha256'),'hex'))
      returning id into v_owner_id;
  end if;

  insert into businesses (tenant_id, name, category, city, phone, email, location, owner_user_id, billing_plan, billing_status, cnpj, website, logo_url)
  values (p_tenant_id, p_name, p_category, p_city, p_phone, p_email,
          case when p_lat is not null and p_lng is not null then ST_MakePoint(p_lng,p_lat)::geography else null end,
          v_owner_id, coalesce(p_billing_plan,'FREE'), 'TRIAL', p_cnpj, p_website, p_logo_url)
  returning id into v_business_id;

  update users set business_id = v_business_id where id = v_owner_id;
  return jsonb_build_object('businessId', v_business_id, 'ownerUserId', v_owner_id);
end $function$
;
revoke execute on function public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text) to service_role;

drop function if exists public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text);
create function public.admin_update_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_business_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_category text,
  p_city text,
  p_cnpj text,
  p_website text,
  p_logo_url text
)
returns void
language plpgsql
set search_path to public, extensions
as $function$
declare v_actor users%rowtype;
begin
  select * into v_actor from users where id=p_actor_user_id and tenant_id=p_tenant_id;
  if not found or v_actor.role not in ('ADMIN','SUPER_ADMIN') then raise exception 'FORBIDDEN'; end if;
  update businesses set name=coalesce(p_name,name), phone=coalesce(p_phone,phone), email=coalesce(p_email,email),
    category=coalesce(p_category,category), city=coalesce(p_city,city), cnpj=coalesce(p_cnpj,cnpj),
    website=coalesce(p_website,website), logo_url=coalesce(p_logo_url,logo_url)
    where id=p_business_id and tenant_id=p_tenant_id;
end $function$
;
revoke execute on function public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;

drop function if exists public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision, text, text);
create function public.business_update_own(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_city text,
  p_logo_url text,
  p_category text default null::text,
  p_lat double precision default null::double precision,
  p_lng double precision default null::double precision
)
returns void
language plpgsql
set search_path to public, extensions
as $function$
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
end $function$
;
revoke execute on function public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision) from public, anon, authenticated;
grant  execute on function public.business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision) to service_role;

-- ---------------------------------------------------------------------------
-- 2. As 3 de leitura, de volta aos corpos anteriores
-- ---------------------------------------------------------------------------
-- Mesma assinatura: CREATE OR REPLACE preserva o ACL. business_get_own volta a
-- NAO devolver instagram (so nao usa mais a coluna; a coluna fica).
create or replace function public.business_get_own(p_tenant_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
set search_path to public, extensions
as $function$
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

create or replace function public.list_offers(
  p_tenant_id uuid,
  p_city text default null::text,
  p_category text default null::text,
  p_lat double precision default null::double precision,
  p_lng double precision default null::double precision,
  p_radius_km double precision default null::double precision
)
returns jsonb
language sql
stable
set search_path to public, extensions
as $function$
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
$function$
;

create or replace function public.list_customer_coupons(p_tenant_id uuid, p_customer_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'publicId', co.public_id,
    'status', co.status,
    'issuedAt', co.issued_at,
    'expiresAt', co.expires_at,
    'validatedAt', co.validated_at,
    'title', t.title,
    'businessName', b.name,
    'businessPhone', b.phone
  ) order by co.issued_at desc), '[]'::jsonb)
  from coupons co
  join coupon_templates t on t.id = co.template_id
  join businesses b on b.id = co.business_id
  where co.tenant_id = p_tenant_id and co.customer_id = p_customer_id;
$function$
;

-- ---------------------------------------------------------------------------
-- 3. As funcoes que a p9 criou
-- ---------------------------------------------------------------------------
-- normalize_instagram primeiro: business_public_card nao depende dela, mas as
-- funcoes de escrita ja foram revertidas acima, entao nenhuma chama mais.
drop function if exists public.business_public_card(uuid);
drop function if exists public.normalize_instagram(text);
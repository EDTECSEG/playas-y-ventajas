-- Run como NOVA QUERY no SQL Editor do Supabase (nao abrir function no dashboard).
-- Cria OR REPLACE, entao pode rodar quantas vezes quiser.
CREATE OR REPLACE FUNCTION public.register_business_by_email(
  p_tenant_slug text,
  p_email text,
  p_name text,
  p_category text,
  p_city text,
  p_phone text,
  p_cnpj text,
  p_website text,
  p_logo_url text,
  p_lat double precision,
  p_lng double precision,
  p_internal_code text,
  p_pin text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_tenant      tenants%rowtype;
  v_owner_id    uuid;
  v_business_id uuid;
begin
  select * into v_tenant from tenants where slug = p_tenant_slug;
  if not found then return jsonb_build_object('error', 'TENANT_NOT_FOUND'); end if;

  if p_name is null or trim(p_name) = '' then
    return jsonb_build_object('error', 'INVALID_NAME');
  end if;
  if p_email is null or p_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    return jsonb_build_object('error', 'INVALID_EMAIL');
  end if;
  if length(coalesce(p_pin, '')) < 6 then
    return jsonb_build_object('error', 'WEAK_PIN');
  end if;

  if exists (
    select 1 from users
     where tenant_id = v_tenant.id
       and lower(internal_code) = lower(p_internal_code)
  ) then
    return jsonb_build_object('error', 'CODE_TAKEN');
  end if;

  insert into users (tenant_id, internal_code, role, pin_hash, name, phone, email)
  values (v_tenant.id, lower(p_internal_code), 'MERCHANT',
          encode(digest(p_pin, 'sha256'), 'hex'),
          trim(p_name), p_phone, lower(p_email))
  returning id into v_owner_id;

  insert into businesses (
    tenant_id, name, category, city, phone, email,
    location, owner_user_id, billing_plan, billing_status,
    cnpj, website, logo_url
  )
  values (
    v_tenant.id, trim(p_name), coalesce(p_category, 'servico'), p_city,
    p_phone, lower(p_email),
    case when p_lat is not null and p_lng is not null
         then ST_MakePoint(p_lng, p_lat)::geography else null end,
    v_owner_id, 'FREE', 'TRIAL',
    p_cnpj, p_website, p_logo_url
  )
  returning id into v_business_id;

  update users set business_id = v_business_id where id = v_owner_id;

  return jsonb_build_object(
    'businessId', v_business_id,
    'ownerUserId', v_owner_id,
    'internalCode', lower(p_internal_code)
  );
end;
$function$;

-- ------------------------------------------------------------
-- Auto-cadastro público de empresa (o responsável cria a própria
-- conta, sem precisar do admin), espelhando admin_create_business.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_business(
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
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
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
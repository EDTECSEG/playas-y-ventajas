-- ============================================================
-- Playas y Ventajas - Gerenciar cupons da empresa
-- ============================================================
-- Objetivo:
--   * desativar/reativar um cupom (template) da empresa
--   * editar os dados e a imagem do cupom
--   * impedir que cupons desativados apareçam para o cliente
--     (list_offers) ou sejam resgatados (claim_coupon)
--
-- Como usar (SQL Editor do Supabase):
--   * rode o arquivo inteiro
--   * no painel da empresa (/empresa -> "Criar e gerenciar ofertas")
--     use os botões "Desativar"/"Ativar" e "Editar" de cada cupom
-- ============================================================

-- ------------------------------------------------------------
-- 1) Flag de ativação no template (1 = ativo, 0 = desativado)
-- ------------------------------------------------------------
ALTER TABLE public.coupon_templates
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- ------------------------------------------------------------
-- 2) Empresa desativa/reativa um cupom próprio
--    Somente o MERCHANT dono do negócio do template.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_toggle_template(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid,
  p_is_active boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_owned text;
  v_count int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE public.coupon_templates
  SET is_active = p_is_active
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- ------------------------------------------------------------
-- 3) Empresa edita um cupom próprio
--    Altera título, benefício, estoque e imagem.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_update_template(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid,
  p_title text,
  p_benefit_type text,
  p_benefit_value numeric,
  p_total_stock integer,
  p_image_url text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_owned text;
  v_count int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_title IS NULL OR length(p_title) < 2 THEN
    RAISE EXCEPTION 'TITLE_TOO_SHORT';
  END IF;
  IF p_benefit_value IS NULL OR p_benefit_value <= 0 THEN
    RAISE EXCEPTION 'BENEFIT_VALUE_INVALID';
  END IF;

  UPDATE public.coupon_templates
  SET title = p_title,
      benefit_type = p_benefit_type,
      benefit_value = p_benefit_value,
      total_stock = p_total_stock,
      image_url = p_image_url
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- ------------------------------------------------------------
-- 4) Empresa deleta um cupom próprio
--    Mesmo que já tenha gerado cupons: apaga o cupom e INVALIDA
--    os cupons emitidos. Ao tentar validá-los, a resposta é
--    PROMOTION_ENDED ("promoção acabou").
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION business_delete_template(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_template_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_owned text;
  v_count int;
  v_used int;
BEGIN
  SELECT u.role INTO v_owned
  FROM public.users u
  JOIN public.coupon_templates t ON t.business_id = u.business_id
  WHERE u.id = p_actor_user_id
    AND u.tenant_id = p_tenant_id
    AND t.id = p_template_id;

  IF v_owned IS NULL OR v_owned != 'MERCHANT' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  -- Invalida os cupons que ainda não foram usados (mantém o histórico).
  UPDATE public.coupons
  SET status = 'CANCELLED'
  WHERE template_id = p_template_id
    AND tenant_id = p_tenant_id
    AND status IN ('AVAILABLE', 'EXPIRED');

  DELETE FROM public.coupon_templates
  WHERE id = p_template_id AND tenant_id = p_tenant_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

-- ------------------------------------------------------------
-- 5) Ofertas públicas ignoram cupons desativados
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_offers(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'templateId', t.id, 'title', t.title, 'benefitType', t.benefit_type, 'benefitValue', t.benefit_value,
    'businessId', b.id, 'businessName', b.name, 'category', b.category, 'city', b.city, 'imageUrl', t.image_url
  )), '[]'::jsonb)
  from coupon_templates t
  join campaigns c on c.id = t.campaign_id and c.status = 'PUBLISHED'
  join businesses b on b.id = t.business_id and b.is_active
  where t.tenant_id = p_tenant_id
    and t.is_active
    and (t.total_stock is null or t.issued_count < t.total_stock)
    and (t.valid_until is null or t.valid_until > now());
$function$
;

-- ------------------------------------------------------------
-- 5) Resgate rejeita cupom desativado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_coupon(p_tenant_id uuid, p_template_id uuid, p_customer_phone text, p_customer_name text, p_customer_instagram text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare v_customer_id uuid; v_template coupon_templates%rowtype; v_raw_token text; v_public_id text; v_coupon_id uuid; v_already_has int; v_short_code text;
begin
  select * into v_template from coupon_templates where id = p_template_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'NOT_FOUND: template'; end if;
  if not v_template.is_active then raise exception 'COUPON_INACTIVE'; end if;
  select id into v_customer_id from users where tenant_id = p_tenant_id and internal_code = p_customer_phone;
  if not found then
    insert into users (tenant_id, internal_code, role, phone, name, instagram, email)
      values (p_tenant_id, p_customer_phone, 'CUSTOMER', p_customer_phone, p_customer_name, p_customer_instagram, p_customer_email) returning id into v_customer_id;
  else
    update users set name = coalesce(p_customer_name, name), instagram = coalesce(p_customer_instagram, instagram), email = coalesce(p_customer_email, email) where id = v_customer_id;
  end if;
  select count(*) into v_already_has from coupons where template_id = p_template_id and customer_id = v_customer_id and status <> 'CANCELLED';
  if v_already_has >= v_template.per_customer_limit then raise exception 'LIMIT_REACHED: customer already claimed this offer'; end if;
  if v_template.total_stock is not null and v_template.issued_count >= v_template.total_stock then raise exception 'COUPON_OUT_OF_STOCK'; end if;
  v_raw_token := encode(gen_random_bytes(32), 'base64');
  v_public_id := 'PYV-' || upper(encode(gen_random_bytes(5), 'hex'));
  v_short_code := lpad(floor(random() * 1000000)::text, 6, '0');
  insert into coupons (public_id, secure_token_hash, short_code_hash, tenant_id, template_id, campaign_id, business_id, customer_id, status, expires_at)
  values (v_public_id, encode(digest(v_raw_token,'sha256'),'hex'), encode(digest(v_short_code,'sha256'),'hex'), p_tenant_id, p_template_id, v_template.campaign_id, v_template.business_id, v_customer_id, 'AVAILABLE', v_template.valid_until)
  returning id into v_coupon_id;
  update coupon_templates set issued_count = issued_count + 1 where id = p_template_id;
  return jsonb_build_object('couponId', v_coupon_id, 'publicId', v_public_id, 'rawToken', v_raw_token, 'shortCode', v_short_code, 'customerId', v_customer_id);
end $function$
;
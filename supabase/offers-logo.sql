-- ============================================================
-- Playas y Ventajas - Logo da empresa nas telas de cupom
-- ============================================================
-- 1) list_offers passa a devolver logoUrl (logo da empresa) além
--    do image_url da oferta. Usado na tela do cupom recém-resgatado.
-- 2) Novo RPC público business_logo_by_id devolve a logo de uma
--    empresa pelo id. Usado na tela de exibição dos meus cupons.
--
-- Como usar (SQL Editor do Supabase): rode o arquivo inteiro.
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_offers(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'templateId', t.id, 'title', t.title, 'benefitType', t.benefit_type, 'benefitValue', t.benefit_value,
    'businessId', b.id, 'businessName', b.name, 'category', b.category, 'city', b.city,
    'imageUrl', t.image_url, 'logoUrl', b.logo_url
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

CREATE OR REPLACE FUNCTION public.business_logo_by_id(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public
AS $function$
declare v_logo text; v_name text;
begin
  select b.logo_url, b.name into v_logo, v_name
  from businesses b where b.id = p_business_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object('businessId', p_business_id, 'name', v_name, 'logoUrl', v_logo);
end $function$
;
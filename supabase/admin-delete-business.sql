-- ------------------------------------------------------------
-- Admin deleta uma empresa cadastrada por engano
-- Remove a empresa e tudo o que depende dela
-- (cupons, templates, campanhas, cobranças e usuário dono).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_business_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_actor users%rowtype;
  v_business businesses%rowtype;
  v_deleted int;
  v_campaign_ids uuid[] := ARRAY(SELECT c.id FROM campaigns c WHERE c.tenant_id = p_tenant_id AND c.business_id = p_business_id);
  v_template_ids uuid[] := ARRAY(SELECT t.id FROM coupon_templates t WHERE t.tenant_id = p_tenant_id AND t.business_id = p_business_id);
  v_coupon_ids uuid[] := ARRAY(SELECT c.id FROM coupons c WHERE c.tenant_id = p_tenant_id AND c.business_id = p_business_id);
BEGIN
  SELECT * INTO v_actor FROM users WHERE id = p_actor_user_id AND tenant_id = p_tenant_id;
  IF NOT found OR v_actor.role NOT IN ('ADMIN','SUPER_ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_business FROM businesses WHERE id = p_business_id AND tenant_id = p_tenant_id;
  IF NOT found THEN
    RAISE EXCEPTION 'NOT_FOUND: business';
  END IF;

  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant_id AND (
    (entity = 'Business' AND entity_id = p_business_id)
    OR (entity = 'Campaign' AND entity_id = ANY(v_campaign_ids))
    OR (entity = 'CouponTemplate' AND entity_id = ANY(v_template_ids))
    OR (entity = 'Coupon' AND entity_id = ANY(v_coupon_ids))
  );
  DELETE FROM public.coupons WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.coupon_templates WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.campaigns WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.billing_charges WHERE tenant_id = p_tenant_id AND business_id = p_business_id;
  DELETE FROM public.users WHERE tenant_id = p_tenant_id AND business_id = p_business_id;

  DELETE FROM public.businesses WHERE tenant_id = p_tenant_id AND id = p_business_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;
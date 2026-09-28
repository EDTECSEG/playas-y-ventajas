-- ============================================================
-- P1 - indices das 22 FKs sem indice coberto (advisor)
-- Ronda como migration p1_index_foreign_keys_22. Idempotente.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_affiliate_rewards_affiliate_reward_template_id ON public.affiliate_rewards (affiliate_reward_template_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_rewards_welcome_template_id ON public.affiliate_rewards (welcome_template_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_business_id ON public.affiliates (business_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_customer_id ON public.affiliates (customer_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_driver_id ON public.affiliates (driver_id);
CREATE INDEX IF NOT EXISTS idx_billing_charges_business_id ON public.billing_charges (business_id);
CREATE INDEX IF NOT EXISTS idx_billing_charges_tenant_id ON public.billing_charges (tenant_id);
CREATE INDEX IF NOT EXISTS idx_business_invites_business_id ON public.business_invites (business_id);
CREATE INDEX IF NOT EXISTS idx_business_invites_created_by ON public.business_invites (created_by);
CREATE INDEX IF NOT EXISTS idx_businesses_owner_user_id ON public.businesses (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by_user_id ON public.campaigns (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_coupon_templates_business_id ON public.coupon_templates (business_id);
CREATE INDEX IF NOT EXISTS idx_coupons_template_id ON public.coupons (template_id);
CREATE INDEX IF NOT EXISTS idx_coupons_validated_by_user_id ON public.coupons (validated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_driver_documents_reviewed_by ON public.driver_documents (reviewed_by);
CREATE INDEX IF NOT EXISTS idx_driver_registration_tokens_tenant_id ON public.driver_registration_tokens (tenant_id);
CREATE INDEX IF NOT EXISTS idx_driver_sessions_tenant_id ON public.driver_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_user_id ON public.referrals (referred_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON public.sessions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_users_business_id ON public.users (business_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_positions_shuttle_id ON public.vehicle_positions (shuttle_id);
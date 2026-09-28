-- ============================================================
-- P1 - initplan das policies (performance)
-- Ronda como migration p1_rls_initplan_optimization.
-- Converte current_setting() em subselect -> avaliacao unica por
-- query (initplan), em vez de por linha. Sem mudanca de semantica.
-- ============================================================
DROP POLICY IF EXISTS tenant_isolation_all ON public.users;
CREATE POLICY tenant_isolation_all ON public.users
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.businesses;
CREATE POLICY tenant_isolation_all ON public.businesses
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.campaigns;
CREATE POLICY tenant_isolation_all ON public.campaigns
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.coupon_templates;
CREATE POLICY tenant_isolation_all ON public.coupon_templates
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.coupons;
CREATE POLICY tenant_isolation_all ON public.coupons
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.audit_logs;
CREATE POLICY tenant_isolation_all ON public.audit_logs
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS tenant_isolation_all ON public.idempotency_keys;
CREATE POLICY tenant_isolation_all ON public.idempotency_keys
  FOR ALL TO public
  USING (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid)
  WITH CHECK (tenant_id = (select current_setting('app.current_tenant_id'::text, true))::uuid);

DROP POLICY IF EXISTS self_tenant_only ON public.tenants;
CREATE POLICY self_tenant_only ON public.tenants
  FOR SELECT TO public
  USING (id = (select current_setting('app.current_tenant_id'::text, true))::uuid);
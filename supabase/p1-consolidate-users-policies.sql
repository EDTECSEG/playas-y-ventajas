-- ============================================================
-- P1 - consolidacao de policies de users
-- Ronda como migration p1_consolidate_users_policies.
-- users tinha 2 policies permissive p/ SELECT (tenant_isolation_select
-- e tenant_isolation_all). A ALL ja cobre SELECT; a SELECT era
-- redundante (advisor multiple_permissive_policies).
-- ============================================================
DROP POLICY IF EXISTS tenant_isolation_select ON public.users;
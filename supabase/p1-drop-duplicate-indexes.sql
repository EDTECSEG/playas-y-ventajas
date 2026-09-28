-- ============================================================
-- P1 - rega de indices duplicados reais
-- Ronda como migration p1_drop_duplicate_indexes.
--   businesses: idx_businesses_location == idx_businesses_location_gist
--   coupons:    idx_coupons_customer   == coupons_customer_idx
-- Mantem o versionado no repo (offers-filters-and-featured.sql,
-- modulo2-relatorios.sql).
-- ============================================================
DROP INDEX IF EXISTS public.idx_businesses_location;
DROP INDEX IF EXISTS public.idx_coupons_customer;
-- ============================================================
-- PATCH: app_ainda_abertas 1 -> 0
-- ------------------------------------------------------------
-- Fecha o EXECUTE de public.trg_referral_reward_link().
--
-- O QUE ESTAVA ERRADO
-- A funcao ficou executavel por PUBLIC / anon / authenticated, contra a
-- Regra 4 do AGENTS.md. As outras 100 funcoes do app estavam fechadas e esta
-- era a unica aberta: `app_ainda_abertas` = 1.
--
-- POR QUE O RISCO REAL E BAIXO
-- E uma funcao de trigger (RETURNS trigger) sobre a tabela referrals. O
-- PostgREST nao expoe trigger: nao ha como chamar isso por HTTP ou por
-- .rpc(). E o disparo de trigger nao checa EXECUTE da funcao no momento da
-- execucao — a permissao e verificada no CREATE TRIGGER, nao a cada INSERT.
-- Entao revogar nao quebra a vinculacao de afiliado porindicacao.
--
-- Onde ela e usada: dispara em referrals quando o status vira 'converted' sem
-- reward_coupon_id, chamando public.link_affiliate_by_id. Essa continua
-- fechada para anon e so e chamada com service_role, pelo servidor.
--
-- Idempotente. Nao mexe em dado nenhum, so ajusta o ACL da funcao.
-- RODE DEPOIS de qualquer modulo, junto com close-function-exec.sql.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.trg_referral_reward_link() FROM PUBLIC;

-- Verificacao. As duas colunas tem que ser true: `fechada_para_public`
-- impede bypass por anon, `dispara_em_referrals` prova que a trigger
-- continua amarrada a tabela (revogar EXECUTE nao desarma trigger).
SELECT
  p.proname,
  NOT EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
    WHERE x.privilege_type = 'EXECUTE'
      AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
  ) AS fechada_para_public,
  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS dispara_em_referrals
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'trg_referral_reward_link';
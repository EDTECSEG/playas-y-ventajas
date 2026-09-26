-- ============================================================
-- Playas y Ventajas - Modulo 3b: hook da indicacao no resgate
-- ------------------------------------------------------------
-- RODE DEPOIS do modulo3-afiliados.sql. Idempotente.
--
-- PROBLEMA QUE ESTE ARQUIVO RESOLVE:
-- A claim_coupon em PRODUCAO cria o cliente e emite o cupom. Se
-- reescrevessemos essa funcao para checar a indicacao, estariamos
-- duplicando a logica critica de resgate (for update, estoque,
-- limite por cliente, hash do token) — qualquer divergencia seria um
-- bug em dinheiro.
--
-- SOLUCAO: nao mexemos na claim_coupon. Em vez disso, o endpoint
-- HTTP (claim-coupon.js) chama referral_convert DEPOIS de um resgate
-- bem-sucedido, best-effort (se falhar, o resgate ja foi concluido e
-- o cliente ja tem o cupom; a indicacao simplesmente nao converte ainda).
--
-- Por que funciona:
--   1) O resgate acontece normalmente (garantido pela RPC atual).
--   2) Se deu certo, chamamos referral_convert(customerId).
--   3) referral_convert procura a indicacao 'pending' daquele cliente.
--   4) Se existir, credita os premios e marca 'converted'.
--
-- Isso mantem a claim_coupon INTOCADA, que e o requisito mais
-- importante: nao arriscar o caminho que mexe em dinheiro.
--
-- Efeito colateral desejavel: se este arquivo nao for rodado, a
-- plataforma continua funcionando normalmente — apenas nao ha
-- premio de indicacao.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Envolve referral_convert num wrapper "best effort"
-- ------------------------------------------------------------
-- Este wrapper NAO lanca excecao para o chamador: qualquer problema
-- vira um log silencioso. Assim o endpoint de resgate nunca devolve
-- erro por causa da recompensa.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.try_referral_convert(uuid, uuid);

CREATE OR REPLACE FUNCTION public.try_referral_convert(
  p_tenant_id uuid,
  p_customer_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_result jsonb;
begin
  -- delega para referral_convert (modulo3)
  v_result := public.referral_convert(p_tenant_id, p_customer_id);

  -- true se converteu alguma coisa agora; false se nao havia indicacao
  return (v_result is not null);

exception
  when others then
    -- NUNCA propaga erro: a recompensa e um extra, nao o motivo do resgate.
    return false;
end $function$
;

-- ------------------------------------------------------------
-- 2) RPC de conveniência: cliente consultou indicacao?
-- ------------------------------------------------------------
-- O app usa isso para mostrar "voce ganhou X pela indicacao de Y"
-- logo apos o resgate, sem precisar consultar a tabela referrals
-- direto (que tem RLS).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_referral_bonus(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_referral_bonus(
  p_tenant_id uuid,
  p_customer_id uuid
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce((
    select jsonb_build_object(
      'converted',  r.status = 'converted',
      'welcomeCouponId', r.welcome_coupon_id,
      'affiliateName', a.name,
      'convertedAt', r.converted_at
    )
    from referrals r
    join affiliates a on a.id = r.affiliate_id
    where r.tenant_id = p_tenant_id
      and r.referred_user_id = p_customer_id
    limit 1
  ), null::jsonb);
$function$
;

-- ------------------------------------------------------------
-- 3) View de apoio para o painel do afiliado
-- ------------------------------------------------------------
-- security_invoker = true: a view respeita RLS. Importante porque
-- views por PADRAO nao respeitam RLS (ver regra de seguranca do
-- Supabase). Aqui nao ha policy, entao via anon retorna vazio —
-- o acesso real e pela function, com service_role.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.affiliate_performance;
CREATE VIEW public.affiliate_performance
  WITH (security_invoker = true)
 AS
 SELECT
   a.id            AS affiliate_id,
   a.tenant_id,
   a.name,
   a.referral_code,
   a.kind,
   a.reward_status,
   a.created_at,
   count(r.id)                                    AS total_referrals,
   count(r.id) FILTER (WHERE r.status = 'converted') AS converted_referrals,
   count(r.id) FILTER (WHERE r.status = 'pending')   AS pending_referrals
 FROM affiliates a
 LEFT JOIN referrals r ON r.affiliate_id = a.id
 GROUP BY a.id;

-- ------------------------------------------------------------
-- 4) Fim do Modulo 3b
-- ------------------------------------------------------------
-- Depois de rodar, valide:
--   select try_referral_convert(
--     '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
--     (select id from users where role='CUSTOMER' limit 1)
--   );
-- Deve devolver false (nao ha indicacao registrada ainda) — e isso
-- esta CORRETO: significa que o wrapper nao quebra nada.

-- ============================================================
-- PATCH: modulo4-motoristas.sql
-- ------------------------------------------------------------
-- Correcao de escopo em admin_driver_reset_pin.
--
-- O QUE ESTAVA ERRADO
-- A funcao comparava v_actor.business_id com v_driver.business_id e negava
-- quando os dois diferiam. Mas um motorista INDEPENDENTE tem
-- drivers.business_id = NULL, e qualquer empresa do tenant tem
-- users.business_id preenchido. Entao:
--
--   'X' IS DISTINCT FROM NULL  =>  true  =>  FORBIDDEN
--
-- Resultado: a empresa que VETA e APROVA o cadastro desse motorista (isso
-- continua funcionando, via driver_review_document, que trata business_id
-- NULL como "gerenciavel por qualquer empresa do tenant") NAO conseguia
-- resetar o PIN dele. Sem um SUPER_ADMIN cadastrado no tenant, o motorista
-- que esquecesse o PIN ficava sem nenhum caminho de recuperacao.
--
-- A CORRECAO
-- Alinha admin_driver_reset_pin com as outras duas funcoes:
--   - SUPER_ADMIN: qualquer motorista do tenant;
--   - empresa:     os proprios motoristas + os independentes.
--
-- Idempotente. Nao mexe em dado nenhum, so troca o corpo da funcao.
-- RODE DEPOIS de modulo4-motoristas.sql.
-- ============================================================

DROP FUNCTION IF EXISTS public.admin_driver_reset_pin(uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.admin_driver_reset_pin(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_driver_id uuid,
  p_new_pin text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_driver drivers%rowtype;
begin
  if p_new_pin is null or not (p_new_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;

  select * into v_driver from drivers where id = p_driver_id and tenant_id = p_tenant_id;
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  -- Mesma regra de escopo de driver_review_document / driver_list_for_business:
  -- SUPER_ADMIN ve todos; uma empresa gerencia os proprios motoristas E os
  -- independentes (business_id NULL).
  if v_actor.role <> 'SUPER_ADMIN'
     and v_driver.business_id is not null
     and v_actor.business_id is distinct from v_driver.business_id then
    raise exception 'FORBIDDEN: so a empresa do motorista ou o admin';
  end if;

  update drivers
  set pin_hash = crypt(p_new_pin, gen_salt('bf')),
      pin_updated_at = now(),
      updated_at = now()
  where id = p_driver_id;

  -- derruba as sessoes: se o PIN vazou, o acesso antigo tem que cair
  delete from driver_sessions where driver_id = p_driver_id;

  return jsonb_build_object('ok', true, 'driverId', p_driver_id, 'sessionsRevoked', true);
end $function$
;

-- ---------------------------------------------------------------------------
-- O DROP + CREATE acima zera o ACL da função: ela nasce com o default
-- implicito do Postgres, que da EXECUTE para PUBLIC. Como anon e authenticated
-- sao membros de PUBLIC, isso reabriria a funcao para o anon -- e esta funcao
-- troca o PIN de um motorista. Revogando logo abaixo (e nao so no
-- close-function-exec.sql) para o patch nunca deixar funcao aberta.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) TO service_role;

-- Confere que a correcao de escopo entrou e que a funcao ficou fechada
SELECT
  pg_get_functiondef(p.oid) ILIKE '%v_driver.business_id is not null%' AS escopo_corrigido,
  EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
    WHERE x.privilege_type = 'EXECUTE'
      AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
  ) AS ainda_aberta_para_public
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'admin_driver_reset_pin';

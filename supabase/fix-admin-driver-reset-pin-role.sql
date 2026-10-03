-- ============================================================
-- PATCH: admin_driver_reset_pin — exige papel de empresa
-- ------------------------------------------------------------
-- O QUE ESTAVA ERRADO
-- admin_driver_reset_pin era a UNICA das quatro rotas de motorista que NAO
-- checava papel do ator. As outras tres (driver_list_for_business,
-- driver_review_document, driver_get_document_path) comecam com:
--
--   if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
--     raise exception 'FORBIDDEN';
--   end if;
--
-- Nela, a unica regra de escopo era sobre business_id:
--
--   if v_actor.role <> 'SUPER_ADMIN'
--      and v_driver.business_id is not null
--      and v_actor.business_id is distinct from v_driver.business_id then
--     raise exception 'FORBIDDEN';
--
-- O buraco: um usuario com role='CUSTOMER' tem business_id NULL (sao 14 no
-- banco). Para um motorista INDEPENDENTE (business_id NULL) a clausula nunca
-- dispara — `v_driver.business_id is not null` e falso. Resultado: qualquer
-- conta de cliente autenticada da plataforma trocava o PIN de um motorista
-- independente, derrubava as sessoas dele e entrava na conta. Aprovacao de
-- documento e reset de PIN deixaram de ser o mesmo poder, e so o reset
-- estava destravado.
--
-- A funcao estava dormente: nenhum endpoint HTTP nem tela chamava
-- admin_driver_reset_pin (a RPC existia desde o modulo 4, orfa). Este patch
-- acompanha a exposicao dela em driver-reset-pin, entao NAO da para publicar a
-- rota antes de aplicar isto.
--
-- A CORRECAO
-- Alinha com as outras tres: primeiro o papel, depois o escopo de business_id.
-- A ordem nao muda o resultado de quem ja podia (SUPER_ADMIN passa nos dois),
-- e mantem o texto de erro igual ao das irmas: 'FORBIDDEN'.
--
-- Idempotente. Nao mexe em dado nenhum, so troca o corpo da funcao.
-- ------------------------------------------------------------

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

  -- Papel antes de escopo. CUSTOMER mora na mesma tabela `users` e tem
  -- business_id NULL, entao a regra de business_id nao o segura.
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

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

-- CREATE OR REPLACE preserva OID, dono e ACL, entao a revogacao abaixo e
-- apenas garantia: se em algum dia este arquivo for aplicado sobre um banco
-- onde a funcao nasceu aberta, ela fecha aqui. Roda sempre, nao faz mal.
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_driver_reset_pin(uuid, uuid, uuid, text) TO service_role;

-- 1) O papel de empresa foi exigido? 2) A funcao continua fechada?
-- As duas colunas tem que ser true. `exige_papel_de_empresa` e o teste que
-- pega a regressao; `ainda_aberta_para_public` o que impede bypass por anon.
SELECT
  pg_get_functiondef(p.oid) ILIKE '%v_actor.role not in (%MERCHANT%' AS exige_papel_de_empresa,
  pg_get_functiondef(p.oid) ILIKE '%SET search_path = public, extensions%' AS search_path_preservado,
  EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) x
    WHERE x.privilege_type = 'EXECUTE'
      AND x.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)
  ) AS ainda_aberta_para_public
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'admin_driver_reset_pin';

-- 2) As quatro rotas de motorista exigem papel de empresa agora. Se alguma
-- linha vier false, a escalatecao do topo desta nota esta de volta.
SELECT
  p.proname,
  pg_get_functiondef(p.oid) ILIKE '%v_actor.role not in (%MERCHANT%' AS exige_papel_de_empresa
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('admin_driver_reset_pin', 'driver_review_document', 'driver_list_for_business', 'driver_get_document_path')
ORDER BY p.proname;
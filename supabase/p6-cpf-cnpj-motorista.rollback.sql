-- =============================================================================
-- Rollback da p6 — des faz o CPF/CNPJ do cadastro de motorista
-- =============================================================================
--
-- QUANDO USAR
--   Se a p6 foi aplicada e algo quebrou antes do deploy do codigo novo. O
--   cadastro volta a funcionar exatamente como estava: 6 parametros, sem
--   fiscal.
--
--   Se a p7 JA foi aplicada, este arquivo sozinho NAO resolve: e preciso rodar
--   primeiro o rollback da p7, senao a p7 reintroduz uma driver_register de 9
--   parametros logo depois desta aqui derrubar. A ordem de volta e p7 -> p6.
--
-- O QUE ESTE ROLLBACK NAO FAZ
--   Apaga as colunas. 'drop column cpf' perderia de vez os CPFs ja
--   preenchidos -- e nao ha de onde recuperar: o backup e o unico caminho, e
--   perder o backup significa perder dado real de motorista.
--
--   As colunas e os indices sao mantidos de proposito. Eles sao inertes: nada
--   no codigo antigo as le, e a proxima p6 reescreve a RPC com `create or
--   replace`. Deixar o schema para tras e o que torna este rollback rapido e
--   seguro de rodar em producao.
-- =============================================================================

-- 1) A RPC volta a aceitar 6 parametros e a recusar os 3 novos.
--    `create or replace` nao serviria aqui: mudar a lista de parametros cria
--    outra sobrecarga, e as duas passariam a existir.
drop function if exists public.driver_register(uuid, text, text, text, uuid, text, text, text, text);
drop function if exists public.driver_register(uuid, text, text, text, uuid, text);

create or replace function public.driver_register(
  p_tenant_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_business_id uuid DEFAULT NULL,
  p_invite_code text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_phone        text;
  v_email        text;
  v_driver_id    uuid;
  v_invite       public.business_invites%rowtype;
  v_business_id  uuid;
  v_pin_token    text;
  v_upload_token text;
  v_recent       integer;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_email := lower(trim(coalesce(p_email, '')));
  if p_name is null or btrim(p_name) = '' then raise exception 'NAME_REQUIRED'; end if;
  if length(v_phone) < 10 then raise exception 'PHONE_INVALID'; end if;
  if v_email not like '%@%' then raise exception 'EMAIL_INVALID'; end if;
  if length(v_phone) > 15 then raise exception 'PHONE_INVALID'; end if;
  if length(btrim(p_name)) > 120 then raise exception 'NAME_TOO_LONG'; end if;

  select count(*) into v_recent
  from public.drivers
  where tenant_id = p_tenant_id and created_at > now() - interval '1 hour';
  if v_recent >= 20 then raise exception 'REGISTRATION_RATE_LIMITED'; end if;

  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and regexp_replace(phone,'\D','','g') = v_phone) then
    raise exception 'PHONE_ALREADY_REGISTERED';
  end if;

  if exists (select 1 from public.drivers where tenant_id = p_tenant_id and lower(email) = v_email) then
    raise exception 'EMAIL_ALREADY_REGISTERED';
  end if;

  v_business_id := p_business_id;
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    select * into v_invite
    from public.business_invites
    where tenant_id = p_tenant_id and code = upper(btrim(p_invite_code))
    for update;
    if not found then raise exception 'INVITE_INVALID'; end if;
    if v_invite.revoked_at is not null then raise exception 'INVITE_INVALID'; end if;
    if v_invite.expires_at is not null and v_invite.expires_at <= now() then raise exception 'INVITE_EXPIRED'; end if;
    if v_invite.uses >= v_invite.max_uses then raise exception 'INVITE_EXHAUSTED'; end if;
    if v_invite.business_id is not null then
      if p_business_id is not null and p_business_id <> v_invite.business_id then raise exception 'INVITE_BUSINESS_MISMATCH'; end if;
      v_business_id := v_invite.business_id;
    end if;
  end if;

  if v_business_id is not null then
    if not exists (select 1 from public.businesses where id = v_business_id and tenant_id = p_tenant_id) then
      raise exception 'BUSINESS_NOT_FOUND';
    end if;
  end if;

  insert into public.drivers (tenant_id, name, phone, email, business_id, status)
  values (p_tenant_id, btrim(p_name), v_phone, v_email, v_business_id, 'pending')
  returning id into v_driver_id;

  v_pin_token    := encode(gen_random_bytes(32), 'hex');
  v_upload_token := encode(gen_random_bytes(32), 'hex');
  insert into public.driver_registration_tokens (tenant_id, driver_id, purpose, token_hash, expires_at)
  values
    (p_tenant_id, v_driver_id, 'pin',    encode(digest(v_pin_token,    'sha256'), 'hex'), now() + interval '2 hours'),
    (p_tenant_id, v_driver_id, 'upload', encode(digest(v_upload_token, 'sha256'), 'hex'), now() + interval '24 hours');

  if v_invite.id is not null then
    update public.business_invites set uses = uses + 1 where id = v_invite.id;
  end if;

  return jsonb_build_object(
    'driverId', v_driver_id,
    'status', 'pending',
    'pinToken', v_pin_token,
    'uploadToken', v_upload_token,
    'message', 'Cadastro criado. Defina seu PIN, envie os documentos e aguarde a aprovacao da empresa.'
  );
end $function$
;

-- 2) A lista da empresa volta a devolver os campos de antes. Mesmo motivo do
--    item 1: a assinatura muda de forma, entao a sobrecarga antiga precisa sair.
drop function if exists public.driver_list_for_business(uuid, uuid, text);

create or replace function public.driver_list_for_business(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_status text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
begin
  select * into v_actor from users where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  if v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'driverId', d.id,
      'name', d.name,
      'phone', d.phone,
      'email', d.email,
      'status', d.status,
      'businessId', d.business_id,
      'createdAt', d.created_at,
      'approvedAt', d.approved_at,
      'documents', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', dd.id,
          'docType', dd.doc_type,
          'status', dd.status,
          'reviewedAt', dd.reviewed_at
        ) order by dd.created_at), '[]'::jsonb)
        from driver_documents dd where dd.driver_id = d.id
      )
    ) order by d.created_at desc)
    from drivers d
    where d.tenant_id = p_tenant_id
      and (p_status is null or d.status = p_status)
      and (
        v_actor.role = 'SUPER_ADMIN'
        or d.business_id is null
        or d.business_id = v_actor.business_id
      )
  ), '[]'::jsonb);
end $function$
;

-- ACL explicito. A funcao de 6 argumentos e DROPpada e recriada acima, entao
-- nasce com o default do schema (EXECUTE para PUBLIC) e, principalmente, SEM
-- EXECUTE para service_role -- que e como o app fala com a RPC. Sem estas duas
-- linhas, rodar este rollback deixa o cadastro de motorista quebrado: o worker
-- continua chamando driver_register e recebe "permission denied".
-- Este grant estava faltando; a guarda tests/driver-cpf-cnpj-guard.test.cjs
-- agora trava a ausencia dele.
revoke execute on function public.driver_register(uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant  execute on function public.driver_register(uuid, text, text, text, uuid, text) to service_role;

-- Mesma razao da driver_register, e mais grave: driver_list_for_business devolve
-- nome, telefone, e-mail, CPF e CNPJ de todos os motoristas do tenant. O
-- DROP + CREATE acima a reabre para PUBLIC (que inclui anon) ate o
-- close-function-exec.sql rodar.
revoke execute on function public.driver_list_for_business(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.driver_list_for_business(uuid, uuid, text) to service_role;

-- 3) Os indices e as colunas ficam. Ver o cabecalho: derruba-los perderia dado.
--    Os validadores public.digits_only / is_valid_cpf / is_valid_cnpj tambem
--    ficam, inertes e revogados. A p6 seguinte sobrescreve os tres com
--    `create or replace`, entao deixa-los nao atrapalha a reaplicacao.

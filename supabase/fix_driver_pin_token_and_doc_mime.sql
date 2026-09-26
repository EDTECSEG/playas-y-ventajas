-- Corrige dois bloqueios do fluxo de cadastro do motorista.
--
-- 1) driver_set_pin nao consome o pinToken.
--    A funcao validava o token contra driver_registration_tokens, mas nunca o
--    apagava nem marcava como usado. O token continuava valido ate expires_at,
--    entao replay dava certo: no E2E, o mesmo pinToken trocou o PIN de 1234
--    para 5678 numa segunda chamada. Quem capturasse o pinToken poderia trocar o
--    PIN do motorista depois. O proprio cliente promete o contrario
--    (app/motorista/logic.js: "ele vale uma vez").
--    A tabela nao tem consumed_at, entao o consome e deletando a linha.
--
-- 2) O bucket pyv-images so aceitava image/png, image/jpeg e image/webp.
--    O handler driver-add-document aceita application/pdf e valida o cabecalho
--    %PDF-, mas o storage rejeitava, entao todo upload de documento falhava com
--    "falha ao armazenar o documento". O bucket foi configurado para o fluxo de
--    logo da empresa e nunca abriu para documentos.
--
-- Observacao sobre privacidade: pyv-images e publico e driver-add-document usa
-- getPublicUrl, entao CNH/RG/CRV ficam servidos publicamente. O caminho tem um
-- UUID aleatorio, o que impede enumerar, mas nao e controle de acesso. Fica
-- registrado aqui como pendencia: mover documentos para um bucket privado com
-- URL assinada.

-- 1) consome o pinToken
CREATE OR REPLACE FUNCTION public.driver_set_pin(
  p_tenant_id uuid,
  p_phone text,
  p_pin text,
  p_pin_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_driver public.drivers%rowtype;
begin
  if p_pin is null or not (p_pin ~ '^[0-9]{4,8}$') then
    raise exception 'PIN_INVALID: use de 4 a 8 digitos';
  end if;

  select * into v_driver
  from public.drivers
  where tenant_id = p_tenant_id
    and regexp_replace(phone, '\D', '', 'g') = regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if not found then raise exception 'DRIVER_NOT_FOUND'; end if;

  if p_pin_token is null or btrim(p_pin_token) = '' then raise exception 'AUTH_REQUIRED'; end if;

  if not exists (
    select 1 from public.driver_registration_tokens t
    where t.driver_id = v_driver.id and t.purpose = 'pin'
      and t.token_hash = encode(digest(btrim(p_pin_token), 'sha256'), 'hex')
      and t.expires_at > now()
  ) then
    raise exception 'TOKEN_INVALID';
  end if;

  if v_driver.status not in ('pending', 'rejected') then raise exception 'TOKEN_INVALID'; end if;

  update public.drivers
  set pin_hash = crypt(p_pin, gen_salt('bf')), pin_updated_at = now(), updated_at = now()
  where id = v_driver.id;

  -- Consome o token. Sem isto, o mesmo pinToken redefine o PIN quantas vezes
  -- quiser ate expirar.
  delete from public.driver_registration_tokens
  where driver_id = v_driver.id
    and purpose = 'pin'
    and token_hash = encode(digest(btrim(p_pin_token), 'sha256'), 'hex');

  return jsonb_build_object('ok', true, 'driverId', v_driver.id);
end;
$function$;

-- 2) abre o bucket para PDF, que e o que driver-add-document valida e envia
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
    updated_at = now()
where id = 'pyv-images';

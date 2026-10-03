-- Precisao (accuracy) da posicao do motorista.
--
-- Por que: vehicle_positions guarda UM ponto por driver_id (upsert). O ponto vem
-- do getCurrentPosition() do navegador que esta com a pagina aberta. Num
-- computador sem GPS, o navegador cai para localizacao por Wi-Fi/IP e devolve
-- um palpite grosseiro (centenas de metros a dezenas de km, no no da operadora).
-- Como e a mesma linha, esse palpite sobrescrevia a posicao real do celular.
--
-- Aqui so guardamos o raio de confianca que o navegador ja informa
-- (coords.accuracy, em metros). A decisao de transmitir ou nao vive no cliente
-- (app/motorista/logic.js, accuracyOk); o banco so faz a sanidade do valor e
-- devolve o campo para o mapa poder marcar um pin impreciso.

-- 1) Coluna. Teto de 100 km so para barrar lixo; o limite de POLITICA e 150 m
--    no cliente.
ALTER TABLE public.vehicle_positions
  ADD COLUMN IF NOT EXISTS accuracy_m double precision
    CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 100000));

COMMENT ON COLUMN public.vehicle_positions.accuracy_m IS
  'Raio de confianca do fix em metros (GPS do aparelho). NULL = desconhecido. Palpite por IP costuma vir enorme.';

-- 2) RPC de escrita: passa a aceitar e gravar a precisao.
--    A assinatura muda, entao a versao antiga e derrubada (senao ficariam duas
--    sobrecarregadas e a antiga seguiria gravando posicao sem precisao).
DROP FUNCTION IF EXISTS public.driver_report_position(uuid, double precision, double precision, double precision, double precision, uuid);

CREATE OR REPLACE FUNCTION public.driver_report_position(
  p_session_token uuid,
  p_lat double precision,
  p_lng double precision,
  p_heading double precision DEFAULT NULL,
  p_speed_kmh double precision DEFAULT NULL,
  p_shuttle_id uuid DEFAULT NULL,
  p_accuracy_m double precision DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_drivers drivers%rowtype;
  v_recorded timestamptz;
begin
  select d.* into v_drivers
    from public.driver_sessions s
    join public.drivers d on d.id = s.driver_id
    where s.token = p_session_token
      and s.expires_at > now();
  if v_drivers.id is null then
    raise exception 'SESSION_EXPIRED';
  end if;
  if v_drivers.status <> 'approved' then
    raise exception 'NOT_APPROVED';
  end if;

  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90
     or p_lng < -180 or p_lng > 180 then
    raise exception 'INVALID_COORDS';
  end if;
  if p_heading is not null and (p_heading < 0 or p_heading >= 360) then
    raise exception 'INVALID_HEADING';
  end if;
  if p_speed_kmh is not null and p_speed_kmh < 0 then
    raise exception 'INVALID_SPEED';
  end if;
  if p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 100000) then
    raise exception 'INVALID_ACCURACY';
  end if;
  if p_shuttle_id is not null and not exists (
    select 1 from public.shuttle_services s
    where s.id = p_shuttle_id
      and s.tenant_id = v_drivers.tenant_id
      and s.is_active
  ) then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  insert into public.vehicle_positions (
    tenant_id, driver_id, shuttle_id, lat, lng, heading, speed_kmh, accuracy_m, recorded_at
  ) values (
    v_drivers.tenant_id, v_drivers.id, p_shuttle_id, p_lat, p_lng,
    p_heading, p_speed_kmh, p_accuracy_m, now()
  )
  on conflict (driver_id) do update set
    tenant_id = excluded.tenant_id,
    shuttle_id = excluded.shuttle_id,
    lat = excluded.lat,
    lng = excluded.lng,
    heading = excluded.heading,
    speed_kmh = excluded.speed_kmh,
    accuracy_m = excluded.accuracy_m,
    recorded_at = excluded.recorded_at
  returning recorded_at into v_recorded;

  return jsonb_build_object('driverId', v_drivers.id, 'recordedAt', v_recorded);
end $function$;

-- ACL: a troca de assinatura some com os grants; refecha no mesmo padrao do repo.
REVOKE ALL ON FUNCTION public.driver_report_position(uuid,double precision,double precision,double precision,double precision,uuid,double precision) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.driver_report_position(uuid,double precision,double precision,double precision,double precision,uuid,double precision) TO service_role;

-- 3) Leitura: expoe accuracyM junto dos demais campos do pin.
CREATE OR REPLACE FUNCTION public.list_live_vehicles(
  p_tenant_id uuid,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_radius_m double precision DEFAULT NULL,
  p_max_age_s integer DEFAULT 300
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
SET search_path = public, extensions
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'driverId', v.driver_id,
      'driverName', d.name,
      'shuttleId', v.shuttle_id,
      'lat', v.lat,
      'lng', v.lng,
      'heading', v.heading,
      'speedKmh', v.speed_kmh,
      'accuracyM', v.accuracy_m,
      'recordedAt', v.recorded_at,
      'distanceKm', case when p_lat is not null
        then round((ST_Distance(
              ST_MakePoint(v.lng, v.lat)::geography,
              ST_MakePoint(p_lng, p_lat)::geography
            ) / 1000)::numeric, 2)
        else null end
    ) order by v.recorded_at desc
  ), '[]'::jsonb)
  from vehicle_positions v
  join drivers d on d.id = v.driver_id and d.status = 'approved'
  where v.tenant_id = p_tenant_id
    and v.recorded_at > now() - make_interval(secs => p_max_age_s)
    and (p_lat is null or p_radius_m is null
         or ST_DWithin(
              ST_MakePoint(v.lng, v.lat)::geography,
              ST_MakePoint(p_lng, p_lat)::geography,
              p_radius_m));
$function$
;

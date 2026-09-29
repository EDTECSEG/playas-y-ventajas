-- ============================================================
-- Playas y Ventajas - Escrita do Modulo 1 (Translado/proximidade)
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR DO SUPABASE (Settings > SQL Editor > New query)
-- Este arquivo e idempotente: pode rodar varias vezes.
--
-- Complementa modulo1-motoristas-translado-proximity.sql, que so trazia
-- as leituras (list_shuttle_services, list_live_vehicles). Aqui ficam os
-- gravadores:
--
--   business_save_shuttle_service    cria/altera um servico do proprio negocio
--   business_toggle_shuttle_service  ativa/desativa um servico proprio
--   business_delete_shuttle_service  apaga um servico proprio
--   business_list_shuttle_services   lista os servicos do proprio negocio
--                                    (inclusive inativos, para o painel)
--   driver_report_position           upsert da posicao do veiculo do motorista
--
-- Mesmo padrao do projeto: SECURITY DEFINER, autorizacao DENTRO da funcao,
-- acesso so do service_role, erro de negocio como 'CODIGO: detalhe' para o
-- rpcErrorCode/rpcErrorStatus traduzirem em HTTP correto.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Empresa: cria/atualiza o proprio servico de translado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_save_shuttle_service(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_service_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_service_type text DEFAULT 'shuttle',
  p_origin_lat double precision DEFAULT NULL,
  p_origin_lng double precision DEFAULT NULL,
  p_dest_lat double precision DEFAULT NULL,
  p_dest_lng double precision DEFAULT NULL,
  p_stops jsonb DEFAULT '[]'::jsonb,
  p_price_cents integer DEFAULT NULL,
  p_opens_at time DEFAULT NULL,
  p_closes_at time DEFAULT NULL,
  p_active_days smallint[] DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_geo geography;
  v_id uuid;
  v_days smallint[] := coalesce(p_active_days, '{0,1,2,3,4,5,6}'::smallint[]);
  v_day smallint;
begin
  -- Ator: usuario do proprio tenant, vinculado a um estabelecimento.
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'FORBIDDEN';
  end if;
  if v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_service_type is null or p_service_type not in ('shuttle','transfer','tour') then
    raise exception 'INVALID_TYPE';
  end if;
  if p_origin_lat is null or p_origin_lng is null
     or p_origin_lat < -90 or p_origin_lat > 90
     or p_origin_lng < -180 or p_origin_lng > 180
     or p_dest_lat is null or p_dest_lng is null
     or p_dest_lat < -90 or p_dest_lat > 90
     or p_dest_lng < -180 or p_dest_lng > 180 then
    raise exception 'INVALID_COORDS';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'INVALID_STOPS';
  end if;
  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_opens_at is not null and p_closes_at is not null and p_closes_at < p_opens_at then
    raise exception 'INVALID_HOURS';
  end if;

  -- active_days: so 0..6, sem duplicados. Vazio = todos os dias.
  if p_active_days is not null then
    if array_length(p_active_days, 1) = 0 then
      v_days := '{0,1,2,3,4,5,6}'::smallint[];
    else
      foreach v_day in array p_active_days loop
        if v_day is null or v_day < 0 or v_day > 6 then
          raise exception 'INVALID_DAYS';
        end if;
      end loop;
      if (select count(distinct d) = count(*) from unnest(p_active_days) d) is false then
        raise exception 'INVALID_DAYS';
      end if;
      v_days := p_active_days;
    end if;
  end if;

  if p_service_id is null then
    insert into public.shuttle_services (
      tenant_id, business_id, name, description, service_type,
      origin, destination, stops, price_cents, opens_at, closes_at, active_days
    ) values (
      p_tenant_id, v_actor.business_id, btrim(p_name), p_description, p_service_type,
      ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      p_stops, p_price_cents, p_opens_at, p_closes_at, v_days
    )
    returning id into v_id;
  else
    -- So o dono edita o proprio servico.
    if not exists (
      select 1 from public.shuttle_services s
      where s.id = p_service_id
        and s.tenant_id = p_tenant_id
        and s.business_id = v_actor.business_id
    ) then
      raise exception 'FORBIDDEN';
    end if;
    update public.shuttle_services set
      name = btrim(p_name),
      description = p_description,
      service_type = p_service_type,
      origin = ST_SetSRID(ST_MakePoint(p_origin_lng, p_origin_lat), 4326)::geography,
      destination = ST_SetSRID(ST_MakePoint(p_dest_lng, p_dest_lat), 4326)::geography,
      stops = p_stops,
      price_cents = p_price_cents,
      opens_at = p_opens_at,
      closes_at = p_closes_at,
      active_days = v_days,
      updated_at = now()
    where id = p_service_id
    returning id into v_id;
  end if;

  return jsonb_build_object('shuttleId', v_id);
end $function$;

-- ------------------------------------------------------------
-- 2) Empresa: ativa/desativa um servico proprio
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_toggle_shuttle_service(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_service_id uuid,
  p_is_active boolean
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_changed boolean := false;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  update public.shuttle_services set
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_service_id
    and tenant_id = p_tenant_id
    and business_id = v_actor.business_id
  returning true into v_changed;

  if v_changed is not true then
    raise exception 'FORBIDDEN';
  end if;
  return v_changed;
end $function$;

-- ------------------------------------------------------------
-- 3) Empresa: apaga um servico proprio
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_delete_shuttle_service(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_service_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
  v_deleted boolean := false;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  delete from public.shuttle_services
  where id = p_service_id
    and tenant_id = p_tenant_id
    and business_id = v_actor.business_id
  returning true into v_deleted;

  if v_deleted is not true then
    raise exception 'FORBIDDEN';
  end if;
  -- vehicle_positions.shuttle_id tem ON DELETE SET NULL: veiculos que apontavam
  -- para o servico apagado seguem visiveis, apenas sem rotulo de servico.
  return v_deleted;
end $function$;

-- ------------------------------------------------------------
-- 4) Empresa: lista os proprios servicos (painel, com inativos)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_list_shuttle_services(
  p_tenant_id uuid,
  p_actor_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path = public, extensions
AS $function$
declare
  v_actor users%rowtype;
begin
  select * into v_actor from public.users
    where id = p_actor_user_id and tenant_id = p_tenant_id;
  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'shuttleId', s.id,
        'name', s.name,
        'description', s.description,
        'serviceType', s.service_type,
        'origin', jsonb_build_object(
          'lat', ST_Y(s.origin::geometry), 'lng', ST_X(s.origin::geometry)),
        'destination', jsonb_build_object(
          'lat', ST_Y(s.destination::geometry), 'lng', ST_X(s.destination::geometry)),
        'stops', s.stops,
        'priceCents', s.price_cents,
        'opensAt', s.opens_at,
        'closesAt', s.closes_at,
        'activeDays', s.active_days,
        'isActive', s.is_active,
        'createdAt', s.created_at,
        'updatedAt', s.updated_at
      ) order by s.created_at desc
    )
    from public.shuttle_services s
    where s.tenant_id = p_tenant_id
      and s.business_id = v_actor.business_id
  ), '[]'::jsonb);
end $function$;

-- ------------------------------------------------------------
-- 5) Motorista: reporta a posicao atual do veiculo
-- ------------------------------------------------------------
-- Exige sessao de motorista valida E status 'approved' (so aprovado fica na
-- frota). O p_driver_id NUNCA vem do cliente: e derivado da sessao no banco,
-- entao um motorista nao consegue gravar posicao em nome de outro.
CREATE OR REPLACE FUNCTION public.driver_report_position(
  p_session_token uuid,
  p_lat double precision,
  p_lng double precision,
  p_heading double precision DEFAULT NULL,
  p_speed_kmh double precision DEFAULT NULL,
  p_shuttle_id uuid DEFAULT NULL
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
  if p_shuttle_id is not null and not exists (
    select 1 from public.shuttle_services s
    where s.id = p_shuttle_id
      and s.tenant_id = v_drivers.tenant_id
      and s.is_active
  ) then
    raise exception 'SHUTTLE_NOT_FOUND';
  end if;

  insert into public.vehicle_positions (
    tenant_id, driver_id, shuttle_id, lat, lng, heading, speed_kmh, recorded_at
  ) values (
    v_drivers.tenant_id, v_drivers.id, p_shuttle_id, p_lat, p_lng,
    p_heading, p_speed_kmh, now()
  )
  on conflict (driver_id) do update set
    tenant_id = excluded.tenant_id,
    shuttle_id = excluded.shuttle_id,
    lat = excluded.lat,
    lng = excluded.lng,
    heading = excluded.heading,
    speed_kmh = excluded.speed_kmh,
    recorded_at = excluded.recorded_at
  returning recorded_at into v_recorded;

  return jsonb_build_object('driverId', v_drivers.id, 'recordedAt', v_recorded);
end $function$;

-- ------------------------------------------------------------
-- 6) Acessos: so o service_role executa (mesmo padrao do projeto)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.business_save_shuttle_service(uuid,uuid,uuid,text,text,text,double precision,double precision,double precision,double precision,jsonb,integer,time,time,smallint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_toggle_shuttle_service(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_delete_shuttle_service(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.business_list_shuttle_services(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_report_position(uuid,double precision,double precision,double precision,double precision,uuid) FROM PUBLIC, anon, authenticated;

GRANT  EXECUTE ON FUNCTION public.business_save_shuttle_service(uuid,uuid,uuid,text,text,text,double precision,double precision,double precision,double precision,jsonb,integer,time,time,smallint[]) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_toggle_shuttle_service(uuid,uuid,uuid,boolean) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_delete_shuttle_service(uuid,uuid,uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.business_list_shuttle_services(uuid,uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.driver_report_position(uuid,double precision,double precision,double precision,double precision,uuid) TO service_role;

-- ------------------------------------------------------------
-- 7) Fim do fluxo de escrita do Modulo 1
-- ------------------------------------------------------------
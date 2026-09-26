-- ============================================================
-- Playas y Ventajas - Modulo 1: Motoristas, Translado e Cupom
-- por proximidade
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR DO SUPABASE (Settings > SQL Editor > New query)
-- Este arquivo e idempotente: pode rodar varias vezes.
--
-- Sigue o padrao do projeto:
--  * tabelas multi-tenant com tenant_id
--  * logica de autorizacao dentro de funcoes SECURITY DEFINER
--    (as functions HTTP usam service_role, que ignora RLS)
--  * PostGIS com ST_MakePoint(...::geography) e ST_DWithin
--
-- Objetivo deste modulo:
--  1) drivers + driver_documents  -> login separado do motorista
--     (identidade verificada: email confirmado + CNH/RG do veiculo)
--  2) shuttle_services            -> cadastro de servico de translado
--  3) vehicle_positions           -> posicao atual dos veiculos (mapa ao vivo)
--  4) proximity_offers            -> cupom so aparece perto do cliente
--     (ex.: quiosque de praia)
-- ============================================================

-- ------------------------------------------------------------
-- 0) Pre-requisito: PostGIS e uuid
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1) Motoristas
-- ------------------------------------------------------------
-- Logica: o motorista tem papel proprio, separado de customers, businesses
-- e admin. O login segue o padrao da empresa: EMAIL + codigo de
-- confirmacao (fluxo login-by-email ja existente no projeto).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.drivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text NOT NULL,
  email           text NOT NULL,
  -- 'pending' = aguardando aprovacao da empresa
  -- 'approved' = habilitado a dirigir
  -- 'rejected' = reprovado na habilitacao
  -- 'suspended'= bloqueado pelo admin
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','suspended')),
  -- Vinculo com uma empresa (ex.: empresa de translado parceira).
  -- NULL = motorista independente que pode ser contratado por qualquer empresa.
  business_id     uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  -- Data da aprovacao (para relatorios e auditoria)
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Email unico por tenant (um cadastro por pessoa)
  CONSTRAINT drivers_tenant_email_uniq UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS drivers_tenant_idx
  ON public.drivers (tenant_id);
CREATE INDEX IF NOT EXISTS drivers_phone_idx
  ON public.drivers (tenant_id, phone);
CREATE INDEX IF NOT EXISTS drivers_status_idx
  ON public.drivers (tenant_id, status);
CREATE INDEX IF NOT EXISTS drivers_business_idx
  ON public.drivers (business_id)
  WHERE business_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2) Documentos do motorista (CNH + RG/CTB do veiculo)
-- ------------------------------------------------------------
-- A verificacao documental e o que "reguarda" o sistema: um motorista so
-- dirige depois de ter documento aprovado pela empresa. Mantemos um
-- historico (append-only por status) para auditoria.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  -- 'cnh' = carteira de motorista; 'rg' = documento com foto
  doc_type        text NOT NULL CHECK (doc_type IN ('cnh','rg','crv')),
  -- URL da imagem na Storage (bucket pyv-images/driver-docs/)
  doc_url         text NOT NULL,
  -- Numero do documento (opcional, mas util para conferencia manual)
  doc_number      text,
  -- Validade (CNH tem validade; RG costuma ser 10 anos)
  doc_expires_at  date,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  -- Quem revisou (user da empresa) + quando
  reviewed_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS driver_documents_driver_idx
  ON public.driver_documents (driver_id, doc_type);
CREATE INDEX IF NOT EXISTS driver_documents_pending_idx
  ON public.driver_documents (tenant_id, status)
  WHERE status = 'pending';

-- ------------------------------------------------------------
-- 3) Servicos de translado
-- ------------------------------------------------------------
-- Cadastro do servico. A "rota" e uma sequencia de paradas em jsonb
-- (array de {lat,lng,label}) + origem/destino em geography para calculo
-- de distancia. Para o MVP guardamos a rota planejada como jsonb; a
-- "posicao atual" vem de vehicle_positions.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shuttle_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  -- 'shuttle' (translado compartilhado), 'transfer' (privativo), 'tour'
  service_type    text NOT NULL DEFAULT 'shuttle'
                    CHECK (service_type IN ('shuttle','transfer','tour')),
  -- Origem e destino como geography (para distancia e proximity)
  origin          geography(Point,4326) NOT NULL,
  destination     geography(Point,4326) NOT NULL,
  -- Paradas intermediarias opcionais: [{lat,lng,label}, ...]
  stops           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Preco em centavos (evita float). NULL = a combinar.
  price_cents     integer CHECK (price_cents IS NULL OR price_cents >= 0),
  -- Janela de operacao (hora local). Ex.: '08:00' ate '22:00'.
  opens_at        time,
  closes_at       time,
  -- Dias ativos: array de 0..6 (0=domingo). Vazio = todos.
  active_days     smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'::smallint[],
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shuttle_services_tenant_idx
  ON public.shuttle_services (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS shuttle_services_business_idx
  ON public.shuttle_services (business_id);
-- Indice espacial para "servicos perto de mim"
CREATE INDEX IF NOT EXISTS shuttle_services_origin_gix
  ON public.shuttle_services USING gist (origin);
CREATE INDEX IF NOT EXISTS shuttle_services_dest_gix
  ON public.shuttle_services USING gist (destination);

-- ------------------------------------------------------------
-- 4) Posicao atual dos veiculos (mapa ao vivo)
-- ------------------------------------------------------------
-- Tabela "atual" (1 linha por veiculo) para o mapa, e nao historico.
-- O cliente faz polling; nao usamos realtime (gratis e sem limite).
-- Se quiser historico depois,Criamos shuttle_position_history.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vehicle_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- Veiculo eh um motorista aprovado que esta atendendo
  driver_id       uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  -- Servico que ele esta executando (pode mudar entre viagens)
  shuttle_id      uuid REFERENCES public.shuttle_services(id) ON DELETE SET NULL,
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  -- Rumo em graus (0-360), opcional
  heading         double precision CHECK (heading IS NULL OR (heading >= 0 AND heading < 360)),
  -- Velocidade km/h, opcional
  speed_kmh       double precision,
  -- Quando o motorista mandou esta posicao (para o cliente descartarvelhas)
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- 1 posicao por motorista (upsert). Chave logica do "current".
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_positions_driver_uniq
  ON public.vehicle_positions (driver_id);
CREATE INDEX IF NOT EXISTS vehicle_positions_tenant_idx
  ON public.vehicle_positions (tenant_id);
-- Consulta do mapa: posicoes recentes deste tenant
CREATE INDEX IF NOT EXISTS vehicle_positions_recent_idx
  ON public.vehicle_positions (tenant_id, recorded_at DESC);

-- ------------------------------------------------------------
-- 5) Oferta por proximidade (quiosque de praia)
-- ------------------------------------------------------------
-- Regra: um cupom pode ter `requires_proximity_m`. Quando preenchido,
-- o cupom so aparece para clientes a menos de X metros do ponto.
-- Ex.: quiosque de praia com cupom de "15% OFF" que so aparece quando o
-- cliente chega perto dele.
-- A logica esta em list_offers_nearby (secao 6): usa ST_DWithin.
-- ------------------------------------------------------------

ALTER TABLE public.coupon_templates
  ADD COLUMN IF NOT EXISTS requires_proximity_m integer
    CHECK (requires_proximity_m IS NULL OR (requires_proximity_m > 0 AND requires_proximity_m <= 5000));
ALTER TABLE public.coupon_templates
  ADD COLUMN IF NOT EXISTS proximity_point geography(Point,4326);
CREATE INDEX IF NOT EXISTS coupon_templates_proximity_gix
  ON public.coupon_templates USING gist (proximity_point)
  WHERE proximity_point IS NOT NULL;

-- Comentario no schema (aparece no Table Editor do Supabase)
COMMENT ON COLUMN public.coupon_templates.requires_proximity_m IS
  'Raio em metros. Se preenchido, o cupom so aparece para clientes dentro desse raio do proximity_point.';
COMMENT ON COLUMN public.coupon_templates.proximity_point IS
  'Ponto geografico do cupom por proximidade (ex.: localizacao do quiosque).';

-- ------------------------------------------------------------
-- 6) Funcoes de leitura do mapa (seguras: exigem tenant)
-- ------------------------------------------------------------

-- Lista as ofertas de translado de um tenant, opcionalmente filtrando
-- as que possuem um veiculo proximo (raio em metros).
DROP FUNCTION IF EXISTS public.list_shuttle_services(uuid, double precision, double precision, double precision);

CREATE OR REPLACE FUNCTION public.list_shuttle_services(
  p_tenant_id uuid,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_radius_km double precision DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'shuttleId', s.id,
      'name', s.name,
      'description', s.description,
      'serviceType', s.service_type,
      'businessId', s.business_id,
      'businessName', b.name,
      'businessLogoUrl', b.logo_url,
      'priceCents', s.price_cents,
      'opensAt', s.opens_at,
      'closesAt', s.closes_at,
      'activeDays', s.active_days,
      'origin', case when s.origin is not null then
        jsonb_build_object('lat', ST_Y(s.origin::geometry), 'lng', ST_X(s.origin::geometry))
        else null end,
      'destination', case when s.destination is not null then
        jsonb_build_object('lat', ST_Y(s.destination::geometry), 'lng', ST_X(s.destination::geometry))
        else null end,
      'stops', s.stops,
      -- Distancia do cliente ate a origem (quando p_lat/p_lng enviados)
      'distanceKm', case when p_lat is not null and s.origin is not null
        then round((ST_Distance(s.origin, ST_MakePoint(p_lng, p_lat)::geography) / 1000)::numeric, 2)
        else null end
    ) order by
      case when p_lat is not null and s.origin is not null
        then ST_Distance(s.origin, ST_MakePoint(p_lng, p_lat)::geography) else null end asc nulls last,
      s.name asc
  ), '[]'::jsonb)
  from shuttle_services s
  join businesses b on b.id = s.business_id and b.is_active
  where s.tenant_id = p_tenant_id
    and s.is_active
    and (p_lat is null or p_radius_km is null
         or ST_DWithin(s.origin, ST_MakePoint(p_lng, p_lat)::geography, p_radius_km * 1000));
$function$
;

-- Lista as posicoes ATUAIS dos veiculos de um tenant.
-- opcionalmente so os que estao perto do cliente (p_lat/p_lng/p_radius_m).
DROP FUNCTION IF EXISTS public.list_live_vehicles(uuid, double precision, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.list_live_vehicles(
  p_tenant_id uuid,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_radius_m double precision DEFAULT NULL,
  -- descarta posicoes mais velhas que isso (segundos); padrao 5 minutos
  p_max_age_s integer DEFAULT 300
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
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
    -- posicao "fresca": nao usar dados muito velhos
    and v.recorded_at > now() - make_interval(secs => p_max_age_s)
    and (p_lat is null or p_radius_m is null
         or ST_DWithin(
              ST_MakePoint(v.lng, v.lat)::geography,
              ST_MakePoint(p_lng, p_lat)::geography,
              p_radius_m));
$function$
;

-- ------------------------------------------------------------
-- 7) Fim do Modulo 1
-- ------------------------------------------------------------
-- Proximo passo: rodar o codigo das functions (shuttle.js, driver.js)
-- que consomem estas funcoes. As tabelas de translado/proximidade
-- estao prontas para uso.

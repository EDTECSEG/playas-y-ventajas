-- ============================================================
-- Playas y Ventajas - Modulo 2: Relatorios (empresa e admin)
-- ------------------------------------------------------------
-- RODE NO SQL EDITOR. Idempotente: pode rodar varias vezes.
--
-- Schema real (verificado no banco em 25/09/2026):
--   users.id, users.tenant_id, users.role, users.business_id,
--   users.created_at, users.internal_code (= telefone do customer)
--   roles: SUPER_ADMIN | MERCHANT | STAFF | CUSTOMER
--   businesses.id, tenant_id, name, is_active, created_at
--   coupons.id, tenant_id, template_id, campaign_id, business_id,
--           customer_id, status, issued_at, validated_at,
--           validated_by_user_id, expires_at
--   coupon_templates.id, business_id, title, is_active, total_stock
--   campaigns.id, business_id, title, status, starts_at, ends_at
--
-- DATAS DE REFERENCIA: usamos issued_at (quando o cliente resgatou) e
-- validated_at (quando a empresa validou). Sao as duas datas que fazem
-- sentido para relatorio. Nao ha created_at em coupons.
--
-- Todos os relatorios aceitam p_de / p_ate (periodo) e devolvem jsonb,
-- no mesmo formato dos outros RPCs do projeto.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Relatorio da EMPRESA: visao geral + serie diaria
-- ------------------------------------------------------------
-- Uma empresa so ve os proprios dados. O dono e identificado por
-- users.business_id, igual ao padrao de business_get_own.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.business_report(uuid, uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.business_report(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_de timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_actor users%rowtype;
  v_de timestamptz;
  v_ate timestamptz;
begin
  -- resolve o ator e garante que ele pertence a uma empresa deste tenant
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found or v_actor.business_id is null then
    raise exception 'FORBIDDEN';
  end if;

  -- periodo default: ultimos 30 dias
  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),

    -- ---------------- totais do periodo ----------------
    'totals', (
      select jsonb_build_object(
        'issued',      count(*),
        'validated',   count(*) filter (where c.status = 'VALIDATED'),
        'available',   count(*) filter (where c.status = 'AVAILABLE'),
        'expired',     count(*) filter (where c.status = 'EXPIRED'),
        'cancelled',   count(*) filter (where c.status = 'CANCELLED'),
        'conversionPct', case when count(*) = 0 then 0
          else round((100.0 * count(*) filter (where c.status = 'VALIDATED') / count(*))::numeric, 1)
        end
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.business_id = v_actor.business_id
        and c.issued_at >= v_de
        and c.issued_at <= v_ate
    ),

    -- ---------------- serie diaria (para grafico) ----------------
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'date',      d.dia,
          'issued',    d.emitidos,
          'validated', d.validados
        ) order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at) as dia,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) d
    ),

    -- ---------------- quebra por campanha ----------------
    'byCampaign', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'campaignId', g.campanha_id,
          'title',      coalesce(camp.title, 'Sem campanha'),
          'issued',     g.emitidos,
          'validated',  g.validados
        ) order by g.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.campaign_id as campanha_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) g
      left join campaigns camp on camp.id = g.campanha_id
    ),

    -- ---------------- quebra por cupom ----------------
    'byTemplate', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'templateId', t.template_id,
          'title',      coalesce(ct.title, 'Sem cupom'),
          'issued',     t.emitidos,
          'validated',  t.validados
        ) order by t.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.template_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.business_id = v_actor.business_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) t
      join coupon_templates ct on ct.id = t.template_id
    ),

    -- ---------------- novos clientes no periodo ----------------
    'newCustomers', (
      select count(*)
      from users cu
      where cu.tenant_id = p_tenant_id
        and cu.role = 'CUSTOMER'
        and cu.created_at >= v_de
        and cu.created_at <= v_ate
    )
  );
end $function$
;

-- ------------------------------------------------------------
-- 2) Relatorio do ADMIN: visao da plataforma
-- ------------------------------------------------------------
-- O admin ve o tenant inteiro (todas as empresas). Validamos o papel
-- SUPER_ADMIN. Mantemos restrito a SUPER_ADMIN por seguranca; se quiser
-- ampliar a categoria depois, e so mudar a condicao nesta function.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_report(uuid, uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.admin_report(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_de timestamptz DEFAULT NULL,
  p_ate timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_actor users%rowtype;
  v_de timestamptz;
  v_ate timestamptz;
begin
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found or v_actor.role <> 'SUPER_ADMIN' then
    raise exception 'FORBIDDEN';
  end if;

  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),

    -- ---------------- totais da plataforma ----------------
    'totals', (
      select jsonb_build_object(
        'issued',      count(*),
        'validated',   count(*) filter (where c.status = 'VALIDATED'),
        'available',   count(*) filter (where c.status = 'AVAILABLE'),
        'conversionPct', case when count(*) = 0 then 0
          else round((100.0 * count(*) filter (where c.status = 'VALIDATED') / count(*))::numeric, 1)
        end,
        'businesses',  (select count(*) from businesses b where b.tenant_id = p_tenant_id),
        'businessesActive', (select count(*) from businesses b where b.tenant_id = p_tenant_id and b.is_active),
        'customers',   (select count(*) from users u where u.tenant_id = p_tenant_id and u.role = 'CUSTOMER'),
        'newCustomers',(select count(*) from users u where u.tenant_id = p_tenant_id and u.role = 'CUSTOMER' and u.created_at >= v_de and u.created_at <= v_ate),
        'drivers',     (select count(*) from drivers d where d.tenant_id = p_tenant_id),
        'driversPending', (select count(*) from drivers d where d.tenant_id = p_tenant_id and d.status = 'pending')
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.issued_at >= v_de
        and c.issued_at <= v_ate
    ),

    -- ---------------- serie diaria da plataforma ----------------
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object('date', d.dia, 'issued', d.emitidos, 'validated', d.validados)
        order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at) as dia,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) d
    ),

    -- ---------------- ranking de empresas ----------------
    'byBusiness', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'businessId', r.business_id,
          'name',       coalesce(b.name, 'Empresa removida'),
          'issued',     r.emitidos,
          'validated',  r.validados
        ) order by r.emitidos desc
      ), '[]'::jsonb)
      from (
        select
          c.business_id,
          count(*) as emitidos,
          count(*) filter (where c.validated_at is not null) as validados
        from coupons c
        where c.tenant_id = p_tenant_id
          and c.issued_at >= v_de
          and c.issued_at <= v_ate
        group by 1
      ) r
      left join businesses b on b.id = r.business_id
    )
  );
end $function$
;

-- ------------------------------------------------------------
-- 3) Indice de apoio para consultas por periodo
-- ------------------------------------------------------------
-- As consultas de relatorio filtram por (tenant_id, business_id, issued_at).
-- Sem indice, um tenant grande faz full scan a cada chamada.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS coupons_tenant_issued_idx
  ON public.coupons (tenant_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS coupons_business_issued_idx
  ON public.coupons (business_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS coupons_customer_idx
  ON public.coupons (customer_id);
CREATE INDEX IF NOT EXISTS users_tenant_role_created_idx
  ON public.users (tenant_id, role, created_at DESC);

-- ------------------------------------------------------------
-- 4) Fim do Modulo 2
-- ------------------------------------------------------------
-- Depois de rodar, valide com um SUPER_ADMIN:
--   select * from admin_report(
--     '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
--     (select id from users where role='SUPER_ADMIN' limit 1)
--   );
-- Deve vir totals com businesses/clientes/customers e daily.

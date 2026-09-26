-- ============================================================
-- Fix: business_report - coluna invalida "t.id"
-- ------------------------------------------------------------
-- CAUSA: no trecho byTemplate, a subconsulta "t" expoe apenas
-- template_id (nao "id" nem "title"). O codigo referenciava t.id e
-- t.title, que nao existem ali. Erro: 42703 "column t.id does not exist".
-- CORRECAO: usar t.template_id e o titulo vem de coupon_templates (ct).
-- Ficheiro autocontido: cria SO a business_report, das demais funcoes
-- do modulo2 (admin_report) NAO e preciso rodar de novo.
-- ============================================================

DROP FUNCTION IF EXISTS public.business_report(uuid, uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.business_report(
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_de              timestamptz DEFAULT NULL,
  p_ate             timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_actor users%rowtype;
  v_de   timestamptz;
  v_ate  timestamptz;
begin
  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  -- Admin/Dono: pode ver o tenant inteiro (mesma logica do business_get_own)
  if not found then
    raise exception 'FORBIDDEN';
  end if;

  if v_actor.role not in ('MERCHANT', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN: apenas empresa ou admin ve o relatorio';
  end if;

  v_de  := coalesce(p_de,  now() - interval '30 days');
  v_ate := coalesce(p_ate, now());

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_de, 'to', v_ate),

    'totals', (
      select jsonb_build_object(
        'issued',        count(*),
        'validated',     count(*) filter (where c.validated_at is not null),
        'available',     count(*) filter (where c.validated_at is null),
        'conversionPct', case when count(*) = 0 then 0
                              else round(100.0 * count(*) filter (where c.validated_at is not null) / count(*), 1)
                             end,
        -- Clientes ATRIBUIVEIS a esta empresa: os que resgataram cupom
        -- dela no periodo. Clientes nao tem business_id, entao a unica
        -- atribuicao confiavel e via cupom. "first_seen" = primeira vez
        -- que este cliente apareceu na empresa (nao re-conta se ja era
        -- cliente antes no periodo).
        'newCustomers',  (
          select count(*) from (
            select c2.customer_id
            from coupons c2
            where c2.tenant_id = p_tenant_id
              and c2.business_id = v_actor.business_id
              and c2.customer_id is not null
              and c2.issued_at >= v_de and c2.issued_at <= v_ate
            group by c2.customer_id
            having min(c2.issued_at) >= v_de
          ) nc
        ),
        -- Total de clientes unicos que ja resgataram desta empresa (nao
        -- limitado ao periodo) - usado como denominador de fidelizacao.
        'totalCustomers', (
          select count(distinct c3.customer_id)
          from coupons c3
          where c3.tenant_id = p_tenant_id
            and c3.business_id = v_actor.business_id
            and c3.customer_id is not null
        ),
        -- Quantos desses clientes voltaram (resgataram 2+ vezes)
        'returningCustomers', (
          select count(*) from (
            select c4.customer_id
            from coupons c4
            where c4.tenant_id = p_tenant_id
              and c4.business_id = v_actor.business_id
              and c4.customer_id is not null
            group by c4.customer_id
            having count(*) > 1
          ) rc
        )
      )
      from coupons c
      where c.tenant_id = p_tenant_id
        and c.business_id = v_actor.business_id
        and c.issued_at  >= v_de
        and c.issued_at  <= v_ate
    ),

    -- ---------------- serie diaria (grafico) ----------------
    'daily', (
      select coalesce(jsonb_agg(
        jsonb_build_object('day', d.dia, 'issued', d.emitidos, 'validated', d.validados)
        order by d.dia
      ), '[]'::jsonb)
      from (
        select
          date_trunc('day', c.issued_at)::date as dia,
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
    )
  );
end $function$
;

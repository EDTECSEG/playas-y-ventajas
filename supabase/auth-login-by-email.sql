-- Run como NOVA QUERY no SQL Editor do Supabase (nao abrir function no dashboard).
-- Cria OR REPLACE, entao pode rodar quantas vezes quiser.
CREATE OR REPLACE FUNCTION public.auth_login_by_email(
  p_tenant_slug text,
  p_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $function$
declare
  v_tenant   tenants%rowtype;
  v_user     users%rowtype;
  v_token    uuid;
  v_user_id  uuid;
begin
  p_email := lower(coalesce(p_email, ''));

  select * into v_tenant from tenants where slug = p_tenant_slug;
  if not found then return jsonb_build_object('error', 'TENANT_NOT_FOUND'); end if;

  select * into v_user
    from users
   where tenant_id = v_tenant.id
     and lower(email) = p_email;
  if not found then return jsonb_build_object('error', 'EMAIL_NOT_FOUND'); end if;

  if v_user.role not in ('MERCHANT', 'ADMIN', 'SUPER_ADMIN') then
    return jsonb_build_object('error', 'ROLE_FORBIDDEN');
  end if;

  insert into sessions (tenant_id, user_id)
  values (v_tenant.id, v_user.id)
  returning token into v_token;

  return jsonb_build_object(
    'sessionToken', v_token,
    'userId', v_user.id,
    'tenantId', v_tenant.id,
    'role', v_user.role,
    'businessId', v_user.business_id
  );
end;
$function$;

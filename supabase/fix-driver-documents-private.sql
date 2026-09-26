-- Documento de motorista deixa de ser URL publica e passa a ser path privado.
--
-- O problema: CNH, RG e CRV ficavam no bucket `pyv-images`, que e public: true
-- por necessidade de fotos, logo de offer, imagem de resize e avatar. Como a
-- visibilidade no Supabase Storage e por BUCKET e nao por prefixo, nao dava
-- para deixar apenas `driver-documents/` privado sem derrubar /midia e o
-- upload-image. Entao a correcao nao e mexer no pyv-images: e dar ao documento
-- um bucket so dele, privado.
--
-- `driver-add-document` passa a gravar em `driver-documents` e guarda em
-- `doc_url` o PATH do objeto, nao a URL. A URL so passa a existir quando
-- alguem autorizado abre o documento, via `driver-document-url`, que assina
-- uma URL de 5 minutos depois de checar quem e o ator.
--
-- Sem dado legado: `driver_documents` esta vazia, entao nao ha migracao de URL
-- antiga para quebrar.

-- 1. Bucket privado, dedicado a documento. Sem policy para anon/authenticated:
--    o acesso passa somente pelo service role dentro de `driver-document-url`.
--    Limites repetidos aqui de proposito: sao a segunda camada, nao a unica,
--    porque `driver-add-document` ja barra 6 MB e so aceita PDF/JPEG/PNG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'driver-documents',
  'driver-documents',
  false,
  6291456,
  array['application/pdf', 'image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Invariante no banco: `doc_url` guarda path, nunca URL.
--    A coluna se chama doc_url por historico, entao o comentario sozinho nao
--    segura. Uma constraint torna o descumprimento impossivel e sobrevive a
--    alguem voltar a chamar getPublicUrl no upload.
alter table public.driver_documents
  drop constraint if exists driver_documents_doc_url_no_http;

alter table public.driver_documents
  add constraint driver_documents_doc_url_no_http
  check (doc_url !~* '^https?://');

comment on column public.driver_documents.doc_url is
  'Path do objeto no bucket privado driver-documents, ex.: driver-documents/<tenant>/<driver>/<uuid>.pdf. NAO e URL: a constraint driver_documents_doc_url_no_http recusa http(s). Para exibir, chame driver-document-url, que assina URL curta apos checar o ator.';

-- 3. Autorizacao + path. Espelha o criterio de driver_list_for_business: papel
--    de empresa e escopo pelo business_id do proprio ator. Devolve o path, e
--    nao a URL, para que a assinatura aconteca fora do banco.
create or replace function public.driver_get_document_path(
  p_tenant_id      uuid,
  p_actor_user_id  uuid,
  p_document_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  users%rowtype;
  v_doc    driver_documents%rowtype;
  v_driver drivers%rowtype;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_document_id is null then
    raise exception 'BAD_REQUEST';
  end if;

  select * into v_actor
  from users
  where id = p_actor_user_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'FORBIDDEN';
  end if;

  if v_actor.role not in ('MERCHANT', 'ADMIN', 'STAFF', 'SUPER_ADMIN') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_doc
  from driver_documents
  where id = p_document_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_driver
  from drivers
  where id = v_doc.driver_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'NOT_FOUND';
  end if;

  -- Mesmo escopo de driver_list_for_business: SUPER_ADMIN ve tudo, empresa ve
  -- os proprios motoristas e tambem os ainda sem empresa vinculada.
  if v_actor.role <> 'SUPER_ADMIN'
     and v_driver.business_id is not null
     and v_driver.business_id <> v_actor.business_id then
    raise exception 'FORBIDDEN';
  end if;

  return jsonb_build_object(
    'documentId', v_doc.id,
    'docType',    v_doc.doc_type,
    'status',     v_doc.status,
    'docNumber',  v_doc.doc_number,
    'driverId',   v_driver.id,
    'driverName', v_driver.name,
    'docPath',    v_doc.doc_url
  );
end;
$$;

revoke all on function public.driver_get_document_path(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.driver_get_document_path(uuid, uuid, uuid) to service_role;

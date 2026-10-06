-- ===========================================================================
-- fix-normalize-instagram - corrige public.normalize_instagram
-- ===========================================================================
-- Data: 2026-10-06. Aplicada no mesmo dia da p9 (p9_contato_publico_empresa,
-- 20261006113429; esta, 20261006120215), depois de validar a p9 em
-- producao com chamadas reais. A p9 criou a funcao com tres defeitos de
-- contrato; nenhum deles mudou a assinatura, entao esta correcao e um simples
-- CREATE OR REPLACE -- o ACL (revoke de public/anon/authenticated, grant para
-- service_role) fica de pe, porque CREATE OR REPLACE nao mexe em privilegio.
--
-- O QUE ESTAVA ERRADO (medido em producao, nao suposto):
--
--   entrada                       antes                 depois
--   '@playas'                     'playas'              'playas'   (ok)
--   'instagram.com/playas'        'instagram.com/playas' 'playas'  (bug 1)
--   '  @novo_perfil  '            '@novo_perfil'         'novo_perfil' (bug 2)
--   'PLAYAS'                      'PLAYAS'              'playas'   (bug 3)
--
-- 1. O prefixo exigia esquema: '^https?://(www\.)?instagram\.com/'. O cabecalho
--    da p9, o placeholder do formulario (i18n.js: instagramCompany) e o
--    proprio teste da p9 anunciavam os quatro formatos, um dos quais era
--    'instagram.com/playas'. Esse formato passava inteiro, e o cliente montava
--    https://instagram.com/instagram.com/playas -- link 404.
--    Correcao: '^((https?://)?(www\.)?instagram\.com/?)'. O '?' final cobre o
--    caso de colarem 'https://instagram.com' sem barra, que virava NULL.
--
-- 2. '^@+' e ancorado e rodava ANTES do btrim. Com espaco a esquerda o '@' nao
--    casava, o btrim de fora tirava o espaco depois, e ficava '@perfil' no
--    banco -- fora do contrato "sem @" que a coluna documenta. Os chamadores
--    (app/empresa e app/admin) enviam o valor do input sem trim.
--    Correcao: btrim(coalesce(p_handle,'')) como ARGUMENTO da primeira troca.
--
-- 3. O API.md descreve o resultado "em minusculas" e nao havia lower().
--    Handle de Instagram e minusculo; a diferenca de caixa no banco faz dois
--    cadastros do mesmo perfil e link errado para quem digita com shift.
--
-- POR QUE UM ARQUIVO SEPARADO E NAO SO EDITAR A p9:
-- a p9 ja rodou em producao. Este arquivo e o que deixa producao igual ao que
-- o arquivo da p9 agora descreve -- o corpo corrigido esta nos DOIS lugares de
-- proposito, para um banco novo (p9) e para este ja migrado (fix) chegarem no
-- mesmo lugar. A p9 traz a explicacao completa no cabecalho da funcao.
--
-- TESTE: tests/p9-contato-empresa-guard.test.cjs passou a extrair os padroes
-- de regexp_replace do SQL e executa-los contra os formatos documentados, em
-- vez de so procurar o texto 'instagram\.com' no corpo -- o assert antigo
-- passava com a funcao errada.
--
-- ROLLBACK: nao ha. Esta correcao so torna a normalizacao mais restritiva, e a
-- coluna businesses.instagram nao tinha NENHUMA linha preenchida na data da
-- correcao (contagem = 0), entao nao ha dado gravado no formato antigo para
-- reprocessar. Se um dia precisar reverter, o corpo anterior esta no historico
-- da p9.
-- ===========================================================================

create or replace function public.normalize_instagram(p_handle text)
returns text
language sql
immutable
set search_path = pg_temp
as $function$
  select nullif(
    lower(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(btrim(coalesce(p_handle, '')), '^((https?://)?(www\.)?instagram\.com/?)', '', 'i'),
            '^@+', ''
          ),
          '/+$', ''
        )
      )
    ),
    ''
  );
$function$
;

-- Nao ha revoke/grant aqui de proposito: CREATE OR REPLACE preserva o ACL ja
-- conferido (anon=false, authenticated=false, service_role=true).
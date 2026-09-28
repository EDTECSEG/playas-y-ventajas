# API — Playas y Ventajas

Mapa de referência: rota pública → handler Netlify → RPC do Supabase → SQL.

## Arquitetura

- **Dois dialetos obrigatórios e idênticos** (mantidos em sincronia pelos testes `tests/consistency.test.cjs`):
  - `netlify/functions/*.js` — CommonJS, roda na Netlify, importa `./_supabaseAdmin`.
  - `functions/.netlify/functions/*.js` — ESM, espelho usado pelo Worker/Pages, importa `./_shared.js` (`json()`, `getSupabaseAdminClient(env)`).
- **`worker/main.js`**: whitelist `ROUTES`. Tudo que não está em `ROUTES` retorna 404; a regex da rota só aceita `[a-z0-9-]`. Chamadas são convertidas para o formato de `event` da Netlify (httpMethod, queryStringParameters, headers, body).
- **Banco**: todas as RPCs são chamadas com a chave service_role (admin client). Autenticação de cliente usa token HMAC (`buildCustomerToken` / `verifyCustomerToken`); sessões de empresa/admin/motorista usam `auth_verify_session` / `driver_verify_session`.
- **`TENANT_ID` fixo**: `0dc57eeb-46c8-47ac-aad4-640d9d59e7b9` (hardcoded em `identify.js`, `affiliates.js` e testes; demais handlers trazem o tenant da sessão/query).

## Functions e endpoints

### `offers` — listagem pública
`GET /.netlify/functions/offers?tenantId=...` (+ parâmetros)
- Sem `mode` → `list_offers` (v3) com filtros por cidade/atividade/raio:
  `city`, `category`, `lat`, `lng`, `radiusKm`. Retorna array com `distanceKm` (quando há lat/lng) e `featured`/`featuredUntil`. Depois `withOfferImages` completa `imageUrl` de `coupon_templates` quando faltar.
- `mode=cities` → `list_cities` (text[]). | `mode=categories` → `list_categories` (text[], normalizadas via `norm_categoria`).
- `mode=my-coupons` → exige `customerId` + `customerToken` (HMAC, anti-IDOR) → `list_customer_coupons`.
- `businessLogoFor=<businessId>` → `business_logo_by_id`.

### `identify` — cadastro/identificação do cliente
`POST /.netlify/functions/identify` `{ phone, name?, email?, instagram?, ref? }`
- RPC `identify_customer` (produção). Devolve `{ customerId, customerToken, referral }`.
- Se `ref` presente → `referral_track` **best-effort fail-open**; `referral` fica `{ code }` ou `null`.

### `claim-coupon` — resgate de cupom
`POST /.netlify/functions/claim-coupon` `{ tenantId, templateId, phone, name?, instagram?, email?, ref? }`
- Caminho crítico: `claim_coupon` (produção, intocada). Depois `try_referral_convert` (convert do indicado) e `loadOfferContext` para montar o link wa.me (`buildWaLink` de `_wa.js`).
- Se `ref` presente e o vínculo não tiver ocorrido no identify → `referral_track` antes do convert. Tudo best-effort: o resgate nunca é bloqueado.
- Resposta: `{ ...claim, customerToken, whatsappUrl, referral, notes }`.

### `login` — sessão de empresa/admin
`POST /.netlify/functions/login` `{ tenantSlug, internalCode, pin }`
- `auth_login` (+ `auth_pin_reset_required` no caso de senha resetada). Retorna sessão com role/tenantId; admin valida role no frontend.

### `empresa` — painel da empresa (sessão `Authorization: Bearer <token>`)
- `GET` (default) → `empresa_dashboard` (produção). `GET ?mode=stats` → `business_coupon_stats`. `GET ?mode=my-data` → `business_get_own`.
- `POST` `{ action }`:
  - `update_my_data` → `business_update_own` v10 (inclui `category`).
  - `create_template` / `update_template` / `toggle_template` / `delete_template` → `create_coupon_template` (produção) / `business_update_template` / `business_toggle_template` / `business_delete_template`.
  - `create_campaign` → `create_campaign` (produção).
  - `set_coupon_featured` `{ templateId, until }` → **`business_set_coupon_featured`** (self-service, novo).
  - `set_pin` → `business_set_pin`.

### `admin` — painel admin (sessão; role ADMIN/SUPER_ADMIN)
- `GET` (default) → `admin_list_businesses` (produção). Modes:
  - `billing` → `admin_billing_panel` · `featured` → `admin_featured_ranks` · `customers` → `admin_list_customers` (produção).
  - `affiliates` → **`admin_affiliate_report`** · `affiliate-rewards` → **`admin_get_affiliate_rewards`** (`{ config }`).
- `POST` `{ action }`: `create_business`, `toggle_business`, `set_featured` (rank), `set_billing`, `update_business`, `request_password_reset`, `update_customer`, `delete_business`, `set_coupon_featured` (override/limpeza → `admin_set_coupon_featured`), `set_affiliate_rewards` (→ **`admin_set_affiliate_rewards`**, com `requireFirstClaim !== false`).

### `affiliates` — módulo afiliado (público, sem sessão)
- `POST` `{ name, phone, email?, kind? }` → `affiliate_register`. Devolve `{ affiliateId, referralCode, shareUrl }`.
- `GET ?affiliateId=&phone=` → `affiliate_dashboard` (valida telefone; `null` vira `{}`).

### `validate-coupon` — validação pelo estabelecimento
`POST` → `validate_and_redeem_coupon` (produção) — fluxo do dono, intocada.

### Mapas / infra
- `map-places` → Overpass (OSM, sem dado de cliente). · `radar` → `find_nearby_businesses`. · `upload-image` → storage (sem RPC).

### Motorista (`driver-*`, Worker `routes/drivers`)
Vínculo por telefone: `driver_register`, `driver_set_pin`, `driver_login`, `driver_logout`, `driver_verify_session`, `driver_list_for_business`, `driver_review_document`, `driver_add_document`, `driver_get_document_path` (+ `business_generate_invite`, `business_logo_by_id` usados pela classe). Frontend em `app/motorista` com lógica pura testada em `motorista/logic.js`.

## RPCs novas (neste pacote — aguardando migração)

| RPC | Arquivo SQL | O que faz |
| --- | --- | --- |
| `list_categories(p_tenant_id)` | `supabase/offers-v3-filters-and-coupon-featured.sql` | Categorias ativas e normalizadas |
| `norm_categoria(text)` | idem | Normaliza categoria (lower + sem acento) |
| `list_offers(v3, 6 args)` | idem | Ordena: destaque ativo → rank → distância → nome; retorna `featured`, `featuredUntil`, `distanceKm` |
| `business_set_coupon_featured` | idem | Self-service da empresa (zera o anterior) |
| `admin_set_coupon_featured` | idem | Override/limpeza pelo admin |
| `business_update_own` v10 | idem | Adiciona `category` |
| `affiliate_dashboard` | `supabase/affiliates-wiring.sql` | Perfil + números + lista de indicações (validado por telefone) |
| `admin_affiliate_report` | idem | Relatório geral (plpgsql, checa role) |
| `admin_get/set_affiliate_rewards` | idem | Config de cupons-prêmio (fail-open sem config) |

**Nota**: as funções de produção (linha "produção" acima) não têm arquivo `.sql` no repo — vivem apenas no Supabase remoto. Não edite produção sem passar pelo `supabase` (migração versionada + advisors).

## RPCs existentes apenas em produção (sem `.sql` no repo)

`admin_billing_panel`, `admin_create_business`, `admin_list_businesses`, `admin_list_customers`, `admin_request_password_reset`, `admin_set_billing`, `admin_toggle_business`, `admin_update_business`, `admin_update_customer`, `auth_login`, `auth_pin_reset_required`, `auth_verify_session`, `business_coupon_stats`, `business_delete_template`, `business_set_pin`, `business_toggle_template`, `business_update_template`, `create_campaign`, `create_coupon_template`, `empresa_dashboard`, `identify_customer`, `list_customer_coupons`, `validate_and_redeem_coupon`.

## Frontend (roteamento do app)

`/` (captura `?ref=` → `localStorage.pyv_ref`), `/cliente` (filtros cidade/atividade/raio + "Perto de mim" + badge ⭐ + repasse de `ref` no identify/claim), `/empresa` (categoria em Meus dados + destaque por período + aba Instagram com gerador de card 1080×1080 em canvas), `/admin` (seção Afiliados: relatório + config de rewards), `/afiliado` (cadastro, link com QR, WhatsApp/Instagram, painel), `/motorista`.

## Migrações a aplicar (após aprovação)

1. `supabase/offers-v3-filters-and-coupon-featured.sql` — coluna `featured_until`, `norm_categoria`, `list_categories`, `list_offers` v3, `business_set_coupon_featured`, `admin_set_coupon_featured`, `business_update_own` v10, e DROPs das assinaturas antigas (`list_offers(uuid)`, `business_update_own` 9-arg).
2. `supabase/affiliates-wiring.sql` — `affiliate_dashboard`, `admin_affiliate_report`, `admin_get/set_affiliate_rewards` (dependem do Módulo 3/3b já aplicado).
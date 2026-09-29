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
- Fase 2 (taxa por cupom): no sucesso, handler chama **`billing_record_coupon_tax`** (`p_tenant_id`, `p_template_id`, `p_coupon_id`) best-effort (try/catch — o 200 nunca cai; falha é logada e ignorada).
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
- Fase 2: `admin_list_businesses` devolve `billingFeeCents` (e `monthlyFeeCents`); `set_billing` aceita `p_plan='PER_COUPON'` → grava a taxa em `billing_fee_cents` (mensal zerada); demais planos → `monthly_fee_cents` (taxa por cupom zerada).

### `affiliates` — módulo afiliado (público, sem sessão)
- `POST` `{ name, phone, email?, kind? }` → `affiliate_register`. Devolve `{ affiliateId, referralCode, shareUrl }`.
- `GET ?affiliateId=&phone=` → `affiliate_dashboard` (valida telefone; `null` vira `{}`).

### `validate-coupon` — validação pelo estabelecimento
`POST` → `validate_and_redeem_coupon` (produção) — fluxo do dono, intocada.

### `billing` — assinatura mensal Mercado Pago (sessão; MERCHANT dono da empresa ou ADMIN/SUPER_ADMIN)
- `POST` (Bearer) `{ action, businessId }`:
  - `status` → `billing_mp_prepare` → `{ subscriptionId, subscriptionUrl }`.
  - `create` → `billing_mp_prepare` (valida plano/valor/ator) → `POST /preapproval` do MP (`status:"pending"`, `auto_recurring` 1x/mês, `notification_url` → `billing-webhook`) → `billing_mp_register` grava `billing_subscription_id/url`. Devolve `{ initPoint, subscriptionId, already }`; se já existe assinatura, reabre o mesmo `init_point` (não duplica). Rollback: cancela a preapproval no MP se o registro falhar.
  - `cancel` → cancela no MP (best-effort) → `billing_mp_cancel`.
- Envs: `MP_ACCESS_TOKEN`, `MP_NOTIFICATION_URL` (ou `NEXT_PUBLIC_SITE_URL` + sufixo webhook), `MP_API_BASE` (teste).
- Segredos (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) ficam só no servidor; o browser só vê `initPoint`.
- Fase 2: plano `PER_COUPON` **não é assinatura** — `billing_mp_prepare` rejeita com `PLAN_NOT_SUBSCRIPTION`. A taxa por resgate é acumulada em `billing_charges` (`coupon_id` preenchido, dedupe por cupom) e cobrada manualmente pelo admin; o painel `billing` do `/admin` lista essas linhas.

### `billing-webhook` — webhook de Assinatura do MP (PÚBLICO, sem sessão)
- `POST /.netlify/functions/billing-webhook` (query `data.id`/`type` + headers `x-signature`, `ts`, `x-request-id`).
- Autenticação: manifest `id:...;request-id:...;ts:...;` → HMAC-SHA256(`MP_WEBHOOK_SECRET`) hex, comparação *timing-safe*, tolerância de relógio de 10 min. Falha → 403, sem detalhe.
- `subscription_authorized_payment` → `GET /authorized_payments/{data.id}` → `billing_mp_webhook_charge` (dedupe por `provider_payment_id`; `coupon_id` NULL).
- `subscription_preapproval` → `GET /preapproval/{data.id}` → `billing_mp_webhook_preapproval` (`authorized`→ACTIVE, `cancelled`→CANCELLED).
- Tipos desconhecidos → 200. RPCs de webhook são inalcançáveis ao cliente (EXECUTE só `service_role`).

### Mapas / infra
- `map-places` → Overpass (OSM, sem dado de cliente). · `radar` → `find_nearby_businesses`. · `upload-image` → storage (sem RPC).

### `shuttle` — translado/proximidade (público, sem sessão)
`GET /.netlify/functions/shuttle?tenantId=...` (+ parâmetros)
- Sempre devolve `{ services: [], vehicles: [] }` (duas RPCs STABLE do Módulo 1, via client de administração):
  - `list_shuttle_services` → serviços de translado ativos do tenant (`shuttleId`, `name`, `serviceType`, `businessName`, `priceCents`, `opensAt`, `closesAt`, `activeDays`, `origin/destination` `{lat,lng}`, `stops`, `distanceKm`).
  - `list_live_vehicles` → posições frescas dos veículos (`driverId`, `driverName`, `lat/lng`, `heading`, `speedKmh`, `recordedAt`, `distanceKm`), descartando posições mais velhas que `maxAgeS` (padrão 300 s).
- Parâmetros opcionais: `lat` + `lng` (juntos, numéricos), `radiusKm` (aplica o raio nos serviços em km e nos veículos em m = radiusKm×1000; exige lat/lng), `maxAgeS` (inteiro positivo).
- Sem `lat/lng`: lista tudo sem `distanceKm` (contrato explícito com o cliente — a UI mostra "sem distâncias"). Sem dados → `[]` (os dois campos sempre presentes).

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
| `billing_mp_prepare` | `supabase/billing-mercadopago-subscriptions.sql` | Valida ator/empresa/plano; devolve payload da preapproval (ou o url já existente) |
| `billing_mp_register` | idem | Grava `billing_subscription_id/url` após criar no MP |
| `billing_mp_cancel` | idem | Limpa assinatura locaç e marca `CANCELLED` |
| `billing_mp_webhook_preapproval` | idem | Evento `subscription_preapproval` → status do negócio |
| `billing_mp_webhook_charge` | idem | `subscription_authorized_payment` → insere `billing_charges` (dedupe) + ACTIVE |
| `billing_record_coupon_tax` | `supabase/p2-taxa-por-cupom.sql` | Fase 2: grava taxa por resgate (plano `PER_COUPON`) em `billing_charges` com `coupon_id`; dedupe por cupom; devolve `true/false` (via em conflito). Excludente com `billing_mp_*` |

**Nota**: as funções de produção (linha "produção" acima) não têm arquivo `.sql` no repo — vivem apenas no Supabase remoto. Não edite produção sem passar pelo `supabase` (migração versionada + advisors).

## RPCs existentes apenas em produção (sem `.sql` no repo)

`admin_billing_panel`, `admin_create_business`, `admin_list_businesses`, `admin_list_customers`, `admin_request_password_reset`, `admin_set_billing`, `admin_toggle_business`, `admin_update_business`, `admin_update_customer`, `auth_login`, `auth_pin_reset_required`, `auth_verify_session`, `business_coupon_stats`, `business_delete_template`, `business_set_pin`, `business_toggle_template`, `business_update_template`, `create_campaign`, `create_coupon_template`, `empresa_dashboard`, `identify_customer`, `list_customer_coupons`, `validate_and_redeem_coupon`, `list_shuttle_services`, `list_live_vehicles` (as duas últimas do Módulo 1 têm `.sql` versionado em `supabase/modulo1-motoristas-translado-proximity.sql`, já aplicado).

## Frontend (roteamento do app)

`/` (captura `?ref=` → `localStorage.pyv_ref`), `/cliente` (filtros cidade/atividade/raio + "Perto de mim" + badge ⭐ + repasse de `ref` no identify/claim, mapa Leaflet, **Translado e proximidade**: serviços de translado + veículos ao vivo com geolocalização e empty state honesto), `/empresa` (categoria em Meus dados + destaque por período + aba Instagram com gerador de card 1080×1080 em canvas), `/admin` (seção Afiliados: relatório + config de rewards), `/afiliado` (cadastro, link com QR, WhatsApp/Instagram, painel), `/motorista`.

## Migrações a aplicar (após aprovação)

1. `supabase/offers-v3-filters-and-coupon-featured.sql` — coluna `featured_until`, `norm_categoria`, `list_categories`, `list_offers` v3, `business_set_coupon_featured`, `admin_set_coupon_featured`, `business_update_own` v10, e DROPs das assinaturas antigas (`list_offers(uuid)`, `business_update_own` 9-arg).
2. `supabase/affiliates-wiring.sql` — `affiliate_dashboard`, `admin_affiliate_report`, `admin_get/set_affiliate_rewards` (dependem do Módulo 3/3b já aplicado).
3. `supabase/p2-taxa-por-cupom.sql` — **fase 2** (aplacada em 3 migrations via MCP: `p2_taxa_por_cupom`, `p2_billing_plan_check_per_coupon`, `p2_fix_billing_record_coupon_tax_null`): coluna `businesses.billing_fee_cents`, índice parcial `idx_billing_charges_coupon_id`, plano `PER_COUPON` no check, RPC `billing_record_coupon_tax` (SECURITY DEFINER, `search_path` fixo, EXECUTE só `service_role`) e ajustes de `admin_set_billing`/`admin_list_businesses`/`billing_mp_prepare`.
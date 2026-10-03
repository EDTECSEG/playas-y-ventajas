# MANUAL DE UTILIZAÇÃO - PLAYAS Y VENTAJAS 2.0

> Documento gerado com base em auditoria SOMENTE LEITURA do código-fonte. Não inventa funcionalidades. Citações por rquivo:linha para rastreabilidade.

**Versão:** 1.0
**Data:** 02/10/2026
**Stack:** Next.js 14.2.35 (App Router) · Netlify Functions (adaptadas via Cloudflare Pages Worker) · Supabase (PostgreSQL + PostGIS + RLS)


## ÍNDICE
- [1. INTRODUÇÃO](#1-introdução)
- [2. ACESSO E ENTRADA](#2-acesso-e-entrada)
- [3. PERFIL: CLIENTE (/cliente)](#3-perfil-cliente-cliente)
- [4. PERFIL: EMPRESA (/empresa)](#4-perfil-empresa-empresa)
- [5. PERFIL: ADMIN (/admin)](#5-perfil-admin-admin)
- [6. PERFIL: MOTORISTA (/motorista)](#6-perfil-motorista-motorista)
- [7. RÓTULOS REAIS (i18n)](#7-rótulos-reais-i18n)
- [8. LIMITAÇÕES REAIS DO SISTEMA](#8-limitacoes-reais-do-sistema)

---

## 1. INTRODUÇÃO

**Nome do sistema:** Playas y Ventajas 2.0  
**Identidade visual:** cores definidas em lib/theme.js ([1-12]): primário #0B6E4F, destaque #F2C14E, fundo #F7FBF9, card #FFFFFF, texto #0B3B2C, texto secundário #5B7A6E, bordas #E2ECE7.

Este manual descreve **EXCLUSIVAMENTE** o que está implementado e em funcionamento no código-fonte. Não descreve funcionalidades planejadas. Cada seção cita rquivo:linha para permitir validação direta.

### 1.1 Páginas disponíveis (build estático)
Rotas prerenderizadas confirmadas (
pm run build, tabela de rotas): /, /_not-found, /admin, /afiliado, /cliente, /empresa, /motorista. Ver out/ e tabela do build ([rota app] linhas do build). A página inicial / redireciona para /cliente ([app/page.jsx:56]).


### 3.2 Identificação/Cadastro
Campos: phone (obrigatório), name, instagram, email ([app/cliente/page.jsx:207-209,421]).
Fluxo: preenche → POST /.netlify/functions/identify ([424-427]) → salva em localStorage chave pyv_customer com customerId, customerToken ([412,427]).
Observações: e-mail não verificado ([identify.js:1-3]); telefone obrigatório ([identify.js:11-12]).
Parâmetro ef vai para localStorage chave pyv_ref ([261]).


### 3.3 Resgate de Cupom (claim-coupon)
Disparado ao clicar em Resgatar em uma oferta ([app/cliente/page.jsx:595]).
Requisitos: oferta com 	emplateId, usuário identificado (telefone presente).
Chamada: POST /.netlify/functions/claim-coupon com { tenantId, templateId, phone, name, instagram, email, ref } ([595-596, netlify/functions/claim-coupon.js:66,72]).
Resposta: devolve couponId, publicId, rawToken, shortCode, customerId ([coupon-management.sql:204]).
Após resgate: salva em pyv_coupon_tokens (array) e pyv_coupon_logos ([app/cliente/page.jsx:587,603,606]); abre aba Meus Cupons ([594]).
Erros (mensagens exibidas):
- LIMIT_REACHED → 'Você já resgatou esta oferta.' ([185] claim_coupon) / exibido via data.error ([cliente:600])
- COUPON_OUT_OF_STOCK → 'Cupom esgotado.' ([196])
- NOT_FOUND: template → template não encontrado ([185,186])
- Outros → Não foi possível resgatar. Tente novamente. ([600])


### 3.4 Filtros de Busca
Filtros: Cidade e Categoria ([app/cliente/page.jsx:347-353]).
Distância: botão 'Perto de mim' ([940-952]). Raio padrão 16 km (ilter.radiusKm:16 [225]); valores utilizados: 16 km (auto ao ativar, [287]) e 50 km quando enviado com byDistance ([352]).
Geolocalização: 
avigator.geolocation.getCurrentPosition ([282-292]). Se negada: setGeoStatus('denied'), mensagem 	.locationDenied ([291]). Envia lat,lng,radiusKm junto ([349-353]). Sem geo, distanceKm vem 
ull ([1021]).

### 3.5 Meus Cupons
Acesso via aba Cupons ([cliente: abas não explícitas com setTab aqui; dados por lista: cupons salvos em pyv_coupon_tokens]). Cupons resgatados ficam em localStorage['pyv_coupon_tokens'] ([587,603]). Exibição mostra QR via enderQrWithLogo ([app/cliente/page.jsx:1337-1342]). Status exibido: só AVAILABLE tem tradução; demais aparecem crus ([1352]).

### 3.6 Indicações
ef da URL → localStorage['pyv_ref'] ([261]). Usado no identify/claim-coupon ([424,596]).

---


## 4. PERFIL: EMPRESA (/empresa)

### 4.1 Login
Campos: 	enantSlug (padrão playas-y-ventajas), internalCode, pin ([app/empresa/page.jsx:53]).
Chamada: POST /.netlify/functions/login ([456-463]). Sessão fica em estado local session (não em localStorage) ([52]).
Primeiro acesso pode exigir troca de PIN (mustChangePin) ([66-68]).

### 4.2 Abas disponíveis (ordem real)
Conforme botões ([916-923]):
1. **Ofertas/Campanhas** (	ab='criar') — 	.tabManageOffers ([916])
2. **Validar Cupom** (	ab='validar') — 	.tabValidate ([917])
3. **Meus Dados** (	ab='dados') — 	.tabMyData ([918]); carrega via loadMyData()`r
4. **Instagram** (	ab='ig') — 	.igTab ([919])
5. **Translado** (	ab='translado') — 	.tabShuttles ([920]); loadShuttles()`r
6. **Motoristas** (	ab='motoristas') — 	.tabDrivers ([921]); loadDrivers()`r
7. **Reservas** (	ab='reservas') — 	.tabReservas ([922]); loadReservations(session)`r
8. **Relatório** (	ab='relatorio') — 	.reportTab ([923]); loadReport(session, reportDays)`r

### 4.3 Validador de Cupom
Aba alidar: campos publicId, awToken, shortCode ([empresa:800-810]). Envia via POST /.netlify/functions/validate-coupon com 	enantId, businessId, actorUserId derivados da sessão ([empresa chama validate-coupon com session; função deriva de actor — padrão correto]). Resultado exibido na tela ([empresa:800+]).

### 4.4 Relatórios
Aba elatorio: carrega via loadReport(session, reportDays) ([923]). Chama usiness_report_v3 (via função backend correspondente). Período controlado por eportDays.

---


## 5. PERFIL: ADMIN (/admin)

### 5.1 Acesso
/admin ([app/admin/page.jsx:1]). Login via POST /.netlify/functions/login ([98]).

### 5.2 Abas (visíveis no código)
Botões de aba ([admin:248-275]): gestão de empresas/ofertas/destaques conforme implementação da página. A aba controla criação/edição de empresas, destaque (featured rank) e listagens ([admin:272-275, 299, 319, 341, 360, 365]).

---


## 6. PERFIL: MOTORISTA (/motorista)

Fluxos principais: login por PIN, registro, envio de posição, listagem de corridas e documentos ([app/motorista/page.jsx:9-33, 171,183,209,234,254,279,312,322]).
- Login: driver-login ([234])
- Registro: driver-register ([254]); aceita inviteCode ([260])
- Posição: driver-position ([209]) — posição do veículo gravada no banco.
- Logout: driver-logout ([322])

---


## 7. RÓTULOS REAIS (i18n)
Chaves extraídas de lib/i18n.js (PT-BR):

| Ação | Chave i18n | Linha
|---|---|---|
| Identificar/Entrar | enter | [22]
| Salvar | save | [28]
| Cancelar | cancel | [29]
| Ofertas | offersTitle | [35]
| Filtrar | ilter | [37]
| Perto de mim | 
earMe | [50]
| Meus cupons | myCoupons | [59]
| Resgatar | edeem | [61]
| Compartilhar | share | [62]
| Gerenciar Ofertas | 	abManageOffers | [78]
| Validar Cupom | 	abValidate | [93]
| Meus Dados | 	abMyData | [96]
| Relatório | eportTab | [99]
| Translado | 	abShuttles | [171]
| Motoristas | 	abDrivers | [182]
| Reservas | 	abReservas | [240]
| Localização negada | locationDenied | [338]
| Não foi possível carregar ofertas | offersError | [339]
| Identifique-se primeiro para reservar | eserveIdentifyFirst | [340]

---


## 8. LIMITAÇÕES REAIS DO SISTEMA

### 8.1 Segurança/Cupons (críticos)
- alidate_and_redeem_coupon e issue_coupon_from_template **não existem** nos .sql do repo ([auditoria seção 1]). Não auditáveis por código versionado.
- Hash de token de afiliado derivado de public_id (dado público) ([modulo3-afiliados.sql:425-426]) — não é segredo.
- short_code usa andom() ([coupon-management.sql:199]) — 1M combinações, PRNG não criptográfico.
- claim-coupon.js aceita 	enantId do body **sem sessão** ([claim-coupon.js:66,72]).
- illing_charges: sem RLS nem policy ([0/0] verificado).
- coupons: tem policy, **sem ENABLE RLS** (inerte no repo).
- 20 pontos devolvem error.message cru ao cliente ([admin.js 6, offers.js 5, empresa.js 3, shuttle.js 2, identify/radar/upload-image/affiliates 1]).
- Zero INSERT em udit_logs no repo.

### 8.2 Produto/UI
- **Sem convite de motorista na UI.** usiness-driver-invite.js existe (88 linhas), publicado no Worker, **0 referências em pp/**. pp/motorista/page.jsx:260 espera inviteCode, mas ninguém o gera na tela da empresa.
- Strings fora do i18n: ~45 ([seção 7.2 da auditoria]).
- Geolocalização pedida **sem clique** em /cliente (montagem) ([app/cliente/page.jsx:304-316]).
- Mapas/Places enviam coordenadas para **Geoapify** ([netlify/functions/_mapPlaces.js:161]) — envio a terceiro.
- Sem política de privacidade, banner de consentimento nem rota de exclusão/anonimização para cliente/afiliado.
- Posição de veículo persistida ([app/motorista/page.jsx:209] → driver-position).
- usiness-driver-invite sem chamadores na UI; lib/supabase.js::getSupabasePublicClient() sem consumidores.

### 8.3 Operação
- Mercado Pago indisponível (sem MP_*).
- playas-y-ventajas.com sem DNS.
- alidate_and_redeem_coupon/issue_coupon_from_template **não versionados**.
- eclose-function-exec-r2.sql byte-idêntico a close-function-exec.sql (duplicata).

---

**Observação:** Este manual descreve **apenas o que existe**. Não assume features planejadas. Todas as citações são verificáveis no código-fonte.


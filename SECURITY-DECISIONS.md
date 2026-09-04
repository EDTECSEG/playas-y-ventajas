# Decisão de risco registrada — dependências (2026-09-01)

## Contexto
`npm audit` no projeto `pyv-web` (Next.js) reporta 2 vulnerabilidades "high"
remanescentes após a atualização para `next@14.2.35`:

- Diversos GHSA relacionados a DoS via Image Optimizer, XSS em scripts
  `beforeInteractive`, SSRF em Server Actions, cache poisoning em RSC,
  bypass de middleware com i18n no Pages Router, etc.
- A correção completa indicada pelo `npm audit fix --force` é `next@16.3.4`
  (mudança de major version, breaking change).

## Decisão
Prosseguir com deploy usando `next@14.2.35` (já corrige a vulnerabilidade
**crítica** de RCE do boletim de dez/2025) e **não** aplicar o upgrade para
Next 16 agora.

## Justificativa
Nenhuma das features afetadas pelos GHAs remanescentes está em uso neste
app: sem `next/image`, sem Server Actions, sem Middleware, sem i18n no
Pages Router (o app usa App Router puro, uma página e uma API route de
health-check). A superfície de exposição real destes CVEs específicos é
nula neste código, hoje.

## Condição de revisão obrigatória
Esta decisão **deve ser reavaliada antes de**:
- Adicionar `next/image`, Server Actions, Middleware ou i18n ao projeto.
- Este app passar a manipular dados reais de usuários/cupons (ou seja,
  antes de qualquer Production Gate da seção 39 do Prompt Master).

Responsável pela decisão: usuário do projeto (confirmado em conversa).

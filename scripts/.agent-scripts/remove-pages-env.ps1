# Remove uma variavel de ambiente de um ambito do Pages (production ou preview).
#
# Por que este script existe: `wrangler pages secret delete` so alcanca
# production (confirmado em 2026-10-01). O Preview tem o proprio
# deployment_configs, e a REST API e a unica via.
#
# A RECEITA (mesma do wrangler, lida em wrangler-dist/cli.js):
#   PATCH .../pages/projects/<p>
#   { deployment_configs: { <env>: {
#       env_vars: { <CHAVE>: null },              <-- null APAGA; omitir NAO apaga
#       wrangler_config_hash: <o do GET atual> } } }
#
# O que já falhou aqui, para ninguém repetir:
#   1. OMITIR a chave do env_vars e mandar as outras. A API responde
#      success=true e NAO apaga nada -- silencioso. Foi o primeiro erro.
#   2. `wrangler_config_hash` veio VAZIO no GET deste projeto (o Pages so o
#      devolve em parte dos cenarios). Enviado vazio, o PATCH funciona. Nao
#      da para afirmar que o hash seja a causa da diferenca: o que mudou e
#      comprovadamente o `null`. O campo vai junto porque o wrangler manda,
#      e porque depende do estado do projeto.
# O script sempre confere com um GET novo depois do PATCH, porque success=true
# sem efeito ja aconteceu de verdade aqui.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts\.agent-scripts\remove-pages-env.ps1 -Chave RESEND_API_KEY -Ambito preview
param(
  [Parameter(Mandatory = $true)][string]$Chave,
  [ValidateSet('production', 'preview')][string]$Ambito = 'preview',
  [string]$Projeto = 'playas-y-ventajas',
  [string]$Conta  = 'b392246e4ce19ce08af5b5439da92cff'
)

$ErrorActionPreference = 'Stop'
$cfg = Join-Path $env:USERPROFILE '.wrangler\config\default.toml'
if (-not (Test-Path -LiteralPath $cfg)) { throw "wrangler sem login: rode .\node_modules\.bin\wrangler.cmd login" }
$tok = (Get-Content $cfg | Select-String '^oauth_token' | Select-Object -First 1) -replace '^oauth_token\s*=\s*"|"$',''
if (-not $tok) { throw "oauth_token nao encontrado em $cfg" }

$uri = "https://api.cloudflare.com/client/v4/accounts/$Conta/pages/projects/$Projeto"
$h = @{ Authorization = "Bearer $tok" }

$r = Invoke-RestMethod -Uri $uri -Headers $h -Method Get -TimeoutSec 40
$dc = $r.result.deployment_configs.$Ambito
$hash = $dc.wrangler_config_hash

if (-not ($dc.env_vars.PSObject.Properties.Name -contains $Chave)) {
  Write-Output "${Ambito}: $Chave nao existe. Nada a fazer."
  exit 0
}

$payload = @{
  deployment_configs = @{
    $Ambito = @{
      env_vars = @{ $Chave = $null }
      wrangler_config_hash = $hash
    }
  }
} | ConvertTo-Json -Depth 8

$resp = Invoke-RestMethod -Uri $uri -Headers $h -Method Patch -Body $payload -ContentType 'application/json' -TimeoutSec 40
if (-not $resp.success) { throw "PATCH recusado: " + ($resp.errors | ConvertTo-Json -Compress) }

# Confere com GET novo. success=true sem efeito ja aconteceu.
$confere = Invoke-RestMethod -Uri $uri -Headers $h -Method Get -TimeoutSec 40
$restou = $confere.result.deployment_configs.$Ambito.env_vars.PSObject.Properties.Name -contains $Chave
if ($restou) {
  Write-Output "FALHOU: a API disse success, mas ${Ambito} ainda tem $Chave." -ForegroundColor Red
  exit 1
}
Write-Output "OK: $Chave removida de $Ambito (conferido por GET novo)."
foreach ($p in $confere.result.deployment_configs.$Ambito.env_vars.PSObject.Properties) {
  Write-Output ("  " + $p.Name + " (" + $p.Value.type + ")")
}
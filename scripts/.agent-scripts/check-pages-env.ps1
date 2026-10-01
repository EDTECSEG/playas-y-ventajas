# Confere as variaveis de ambiente do Pages sem NUNCA imprimir valor.
#
# Existe por um motivo concreto: uma verificacao anterior pediu a config do
# projeto pela API e imprimiu SUPABASE_SERVICE_ROLE_KEY e RESEND_API_KEY em
# claro no terminal, porque as duas estavam como plain_text. A API devolve o
# valor literal de um plain_text e devolve "(hidden)" de um secret_text. Este
# script so reporta nome, tipo e se ha valor -- nunca o conteudo.
#
# Uso: powershell -File scripts\.agent-scripts\check-pages-env.ps1

$ErrorActionPreference = 'Stop'
$Conta = 'b392246e4ce19ce08af5b5439da92cff'
$Projeto = 'playas-y-ventajas'

# O que o codigo le. Um secret com valor vazio quebra em producao e um secret
# faltando e o modo silencioso de quebrar: a tela cai num catch e o usuario ve
# "nao foi possivel carregar".
# Publicas podem ficar em plain: o navegador precisa delas e elas vao no HTML
# de todo jeito. As sensiveis tem de ser secret nos DOIS ambientes: o Cloudflare
# guarda Production e Preview em slots separados, e marcar so em Production deixa
# o Preview em texto claro sem nenhum aviso.
$Esperadas = @(
  @{ nome = 'NEXT_PUBLIC_SUPABASE_URL';        secreta = $false; onde = 'production, preview' }
  @{ nome = 'NEXT_PUBLIC_SUPABASE_ANON_KEY';   secreta = $false; onde = 'production, preview' }
  @{ nome = 'SUPABASE_SERVICE_ROLE_KEY';       secreta = $true;  onde = 'production, preview' }
  @{ nome = 'RESEND_API_KEY';                   secreta = $true;  onde = 'production, preview' }
  @{ nome = 'GEOAPIFY_API_KEY';                 secreta = $true;  onde = 'production, preview' }
)

function Obter-Token {
  $cfg = Join-Path $env:USERPROFILE '.wrangler\config\default.toml'
  if (-not (Test-Path $cfg)) { throw "wrangler sem login: rode .\node_modules\.bin\wrangler.cmd login" }
  $linha = Get-Content $cfg | Select-String '^oauth_token' | Select-Object -First 1
  if (-not $linha) { throw "oauth_token ausente em $cfg" }
  $tok = ($linha.Line -replace '^\s*oauth_token\s*=\s*"(.*)"\s*$', '$1')
  $exp = Get-Content $cfg | Select-String 'expiration_time' | Select-Object -First 1
  if ($exp) {
    $quando = ($exp.Line -replace '^\s*expiration_time\s*=\s*"(.*)"\s*$', '$1')
    Write-Host ("credencial wrangler expira em " + $quando + "  (UTC agora " + (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ")")
  }
  return $tok
}

$tok = Obter-Token
$uri = "https://api.cloudflare.com/client/v4/accounts/$Conta/pages/projects/$Projeto"

try {
  $r = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $tok" } -Method Get -TimeoutSec 40
} catch {
  Write-Host "ERRO na API do Cloudflare. Se disser 'Authentication error', o token do wrangler venceu:" -ForegroundColor Red
  Write-Host "  rode .\node_modules\.bin\wrangler.cmd login  e depois rode este script de novo."
  exit 1
}

$problemas = 0
foreach ($amb in @('production', 'preview')) {
  $envVars = $r.result.deployment_configs.$amb.env_vars
  Write-Host ""
  Write-Host "=== $amb ===" -ForegroundColor Cyan
  if (-not $envVars) {
    Write-Host "  nenhuma variavel neste ambiente" -ForegroundColor Yellow
    $problemas++
    continue
  }

  foreach ($e in $Esperadas) {
    $querQuer = $e.onde -like "*$amb*"
    $existe = $envVars.PSObject.Properties.Name -contains $e.nome
    if (-not $querQuer) {
      $marca = if ($existe) { 'existe (fora do esperado)' } else { '-' }
      Write-Host ("{0,-32} {1}" -f $e.nome, $marca)
      continue
    }
    if (-not $existe) {
      Write-Host ("{0,-32} AUSENTE" -f $e.nome) -ForegroundColor Red
      $problemas++
      continue
    }
    # Com parentheses: $envVars.$e.nome nao resolve propriedade dinamica
    # encadeada no PowerShell e devolve $null, o que fazia TODO variavel
    # parecer plain e vazia.
    $v = $envVars.($e.nome)
    $tipoTxt = if ($v.type -eq 'secret_text') { 'secret' } else { 'plain ' }
    # A API esconde o valor de um secret_text devolvendo string VAZIA. Entao nao
    # da para provar, pela API, se um secret tem conteudo: da para provar o tipo.
    # Por isso o texto vai dizer "ok (oculto pela API)" e nao "ok", e por isso
    # um secret sem valor so apareceria aqui como plain_text vazio.
    $temValorVisivel = ($null -ne $v.value -and $v.value -ne '')

    # Publica em secret_text tambem e aceitavel (o Cloudflare esconde um valor
    # que precisa ir para o navegador, e o Next.js le do env no build), entao
    # so uma SENSIVEL que ficou em plain e problema.
    if ($e.secreta -and $v.type -ne 'secret_text') {
      $problemas++
      Write-Host ("{0,-32} {1,-6} {2}" -f $e.nome, $tipoTxt, $(if ($temValorVisivel) { 'PLAIN -- deveria ser secret' } else { 'PLAIN e vazio' })) -ForegroundColor Red
    } elseif ($v.type -eq 'secret_text') {
      Write-Host ("{0,-32} {1,-6} ok (oculto pela API)" -f $e.nome, $tipoTxt) -ForegroundColor Green
    } elseif (-not $temValorVisivel) {
      $problemas++
      Write-Host ("{0,-32} {1,-6} VAZIO" -f $e.nome, $tipoTxt) -ForegroundColor Red
    } else {
      # Publica em plain: mostra o comprimento, nunca o conteudo.
      Write-Host ("{0,-32} {1,-6} ok ({2} caracteres)" -f $e.nome, $tipoTxt, ([string]$v.value).Length) -ForegroundColor Green
    }
  }
}

Write-Host ""
if ($problemas -eq 0) {
  Write-Host "TUDO OK: variaveis presentes, com valor, e nenhuma secreta em texto claro." -ForegroundColor Green
  exit 0
}
Write-Host "$problemas problema(s). Vide a coluna acima." -ForegroundColor Red
exit 1
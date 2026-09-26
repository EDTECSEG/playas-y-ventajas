<#
    do-backup.ps1 -Idx <n>

    Backup do repo PYV, validado no disco, sem sobrescrever nada.

    REGRA 1 do AGENTS.md: backup antes de QUALQUER alteracao.

    Historico de correcoes neste script:
      - o regex de segredo antigo era /\.env(\.local|\.dev)?$/, que NAO casa
        com ".dev.vars" (o arquivo onde AGENTS.md/.gitignore dizem que moram
        SUPABASE_SERVICE_ROLE_KEY e RESEND_API_KEY). Isso deixou 6 backups
        antigos com segredo dentro do zip sem o validador acusar.
      - agora o .dev.vars e barrado em /XF (nao copiado) E no regex de checagem.
#>
param(
  [Parameter(Mandatory = $true)][int]$Idx
)

$ErrorActionPreference = 'Stop'
$repo   = 'C:\Users\REUNIAO\Desktop\pyv-web'
$bkRoot = 'C:\Users\REUNIAO\Desktop\pyv-backups'

if (-not (Test-Path -LiteralPath $repo))   { throw "repo nao existe: $repo" }
if (-not (Test-Path -LiteralPath $bkRoot)) { New-Item -ItemType Directory -Path $bkRoot -Force | Out-Null }

$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$zip   = Join-Path $bkRoot ('pyv-web-backup-' + $Idx + '-' + $stamp + '.zip')
if (Test-Path -LiteralPath $zip) { throw "nao sobrescrevo (ja existe): $zip" }

# Arquivos de segredo: barrados na COPIA (robocopy /XF) e na CHECAGEM do zip.
$secretFiles = @(
  '.dev.vars'
  '.env', '.env.local', '.env.development', '.env.production', '.env.test'
  'db_url*'
  '*.pem', '*.p8', '*.key', '*.p12', 'id_rsa*'
)

# 1) Stage limpo e novo
$stage = Join-Path $env:TEMP ('pyv-bk' + $Idx + '-' + [DateTime]::UtcNow.ToString('HHmmssfff'))
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  # 2) Copia fiel via robocopy (preserva estrutura; exclui pesados/segredos)
  #
  # Passe 1 exclui por NOME. Isso tambem apaga functions\.netlify\functions
  # (o espelho ESM), porque /XD .netlify casa por nome em qualquer nivel.
  # Passe 2 copia o espelho ESM de volta, do caminho real.
  # Nao usar /XD com varios caminhos completos: o robocopy deste host rejeita
  # a lista com "Parametro Invalido #4" e aborta com rc=16.
  & robocopy $repo $stage /E /XD node_modules .next out .wrangler .git .netlify .staging-bk17 `
            /XF @secretFiles /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) { throw "robocopy passe 1 falhou rc=$rc" }

  $esmSrc = Join-Path $repo 'functions\.netlify'
  if (Test-Path -LiteralPath $esmSrc) {
    & robocopy $esmSrc (Join-Path $stage 'functions\.netlify') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    $rc2 = $LASTEXITCODE
    if ($rc2 -ge 8) { throw "robocopy passe 2 (espelho ESM) falhou rc=$rc2" }
  }

  # 3) Prova de que o espelho ESM e o _worker.js chegaram
  $esmBefore = @(Get-ChildItem -LiteralPath (Join-Path $stage 'functions\.netlify\functions') -File -Filter *.js -ErrorAction SilentlyContinue).Count
  $cjsBefore = @(Get-ChildItem -LiteralPath (Join-Path $stage 'netlify\functions')            -File -Filter *.js -ErrorAction SilentlyContinue).Count
  $wkrBefore = @(Get-ChildItem -LiteralPath $stage -File -Filter _worker.js -ErrorAction SilentlyContinue).Count
  Write-Output ("BEFORE_$Idx esm_mirror => " + $esmBefore)
  Write-Output ("BEFORE_$Idx canon_cjs   => " + $cjsBefore)
  Write-Output ("BEFORE_$Idx _worker.js  => " + $wkrBefore)
  if ($esmBefore -eq 0) { throw "espelho ESM nao copiado (antes do zip)" }
  if ($wkrBefore  -eq 0) { throw "_worker.js nao copiado (antes do zip)" }

  # 3a) Paridade CJS/ESM. Nao e fatal (o repo tem desvio conhecido), mas o
  # desvio precisa ficar VISIVEL em toda execucao para nao passar despercebido.
  if ($esmBefore -ne $cjsBefore) {
    Write-Output ("AVISO_$Idx PARIDADE_CJS_ESM => esm=" + $esmBefore + " cjs=" + $cjsBefore + " (ver tests\consistency.test.cjs)")
  }

  # 3b) Prova de que o segredo NAO foi copiado para o stage
  $leaked = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force -ErrorAction SilentlyContinue |
                Where-Object { $secretFiles -contains $_.Name -or $_.Name -like 'db_url*' })
  if ($leaked.Count -gt 0) { throw "segredo no stage: " + (($leaked | ForEach-Object FullName) -join ', ') }

  # 4) Zip novo; NUNCA sobrescrever
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
  if (-not (Test-Path -LiteralPath $zip)) { throw "zip nao criado: $zip" }

  # 5) Validacao CONCRETA no disco - abrir o zip e contar entradas
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try { $names = @($z.Entries.FullName) } finally { $z.Dispose() }

  # Regexes ancorados: sem o ^, o padrao de CJS tambem casaria com
  # functions\.netlify\functions\... e contaria o espelho ESM duas vezes.
  $esmZip = @($names | Where-Object { $_ -match '(^|[\\/])functions[\\/]\.netlify[\\/]functions[\\/][A-Za-z0-9_-]+\.js$' }).Count
  $cjsZip = @($names | Where-Object { $_ -match '(^|[\\/])netlify[\\/]functions[\\/][A-Za-z0-9_-]+\.js$' }).Count
  $wkrZip = @($names | Where-Object { $_ -match '_worker\.js$' }).Count
  $sqlZip = @($names | Where-Object { $_ -match '\.sql$' }).Count

  # Regex corrigido: inclui .dev.vars explicitamente (o padrao antigo nao pegava)
  $secZip = @($names | Where-Object {
    $_ -match '\.dev\.vars$' -or
    $_ -match '(^|[\\/])\.env(\.|$)' -or
    $_ -match 'db_url' -or
    $_ -match '(service_role|SERVICE_ROLE|RESEND_API|service-role)' -or
    $_ -match '\.(pem|p8|p12|key)$' -or
    $_ -match 'id_rsa'
  })

  Write-Output ("ZIP_$Idx  => " + $zip)
  Write-Output ("SIZE_$Idx => " + (Get-Item -LiteralPath $zip).Length)
  Write-Output ("ENT_$Idx  => " + $names.Count)
  Write-Output ("ESM_$Idx  => " + $esmZip)
  Write-Output ("CJS_$Idx  => " + $cjsZip)
  Write-Output ("WKR_$Idx  => " + $wkrZip)
  Write-Output ("SQL_$Idx  => " + $sqlZip)
  Write-Output ("SEC_$Idx  => " + $secZip.Count)

  if ($esmZip -eq 0) { throw "backup invalido: espelho ESM ausente no zip" }
  if ($wkrZip  -eq 0) { throw "backup invalido: _worker.js ausente no zip" }
  if ($secZip.Count -gt 0) { throw "backup invalido: segredo vazou no zip => " + ($secZip -join ', ') }

  Write-Output "BACKUP_VALIDO => TRUE"
}
finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

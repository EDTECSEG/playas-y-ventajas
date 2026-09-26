$ErrorActionPreference = 'Stop'
$repo    = 'C:\Users\REUNIAO\Desktop\pyv-web'
$bkRoot  = 'C:\Users\REUNIAO\Desktop\pyv-backups'
if (-not (Test-Path -LiteralPath $repo))   { throw "repo nao existe: $repo" }
if (-not (Test-Path -LiteralPath $bkRoot)) { New-Item -ItemType Directory -Path $bkRoot -Force | Out-Null }

$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$idx   = 19

# 1) Stage limpo e novo
$stage = Join-Path $env:TEMP ('pyv-bk19-' + [DateTime]::UtcNow.ToString('HHmmssfff'))
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 2) Copia fiel via robocopy (preserva estrutura; exclui pesados/segredos)
robocopy $repo $stage /E /XD node_modules .next out .wrangler .git .netlify /NFL /NDL /NJH /NJS /NP | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { Remove-Item -LiteralPath $stage -Recurse -Force; throw "robocopy falhou rc=$rc" }

# 3) Contagens NA COPIA (antes de zipar) - prova de que o espelho ESM existe
$esmBefore = @(Get-ChildItem -LiteralPath (Join-Path $stage 'functions\.netlify\functions') -File -Filter *.js -ErrorAction SilentlyContinue).Count
$cjsBefore = @(Get-ChildItem -LiteralPath (Join-Path $stage 'netlify\functions') -File -Filter *.js -ErrorAction SilentlyContinue).Count
$wkrBefore = @(Get-ChildItem -LiteralPath $stage -File -Filter _worker.js -ErrorAction SilentlyContinue).Count
Write-Output ("BEFORE_19 esm_mirror => " + $esmBefore)
Write-Output ("BEFORE_19 canon_cjs   => " + $cjsBefore)
Write-Output ("BEFORE_19 _worker.js  => " + $wkrBefore)
if ($esmBefore -eq 0) { Remove-Item -LiteralPath $stage -Recurse -Force; throw "espelho ESM nao copiado (antes do zip)" }
if ($wkrBefore  -eq 0) { Remove-Item -LiteralPath $stage -Recurse -Force; throw "_worker.js nao copiado (antes do zip)" }

# 4) Zip novo; NUNCA sobrescrever
$zip = Join-Path $bkRoot ('pyv-web-backup-' + $idx + '-' + $stamp + '.zip')
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $stage -Recurse -Force; throw "nao sobrescrevo (ja existe): $zip" }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
if (-not (Test-Path -LiteralPath $zip)) { Remove-Item -LiteralPath $stage -Recurse -Force; throw "zip nao criado: $zip" }

# 5) Validacao CONCRETA no disco - abrir o zip e contar entradas
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
try { $names = @($z.Entries.FullName) } finally { $z.Dispose() }

$esmZip = @($names | Where-Object { $_ -match 'functions[\\/]\.netlify[\\/]functions[\\/][A-Za-z0-9_-]+\.js$' }).Count
$cjsZip = @($names | Where-Object { $_ -match 'netlify[\\/]functions[\\/][A-Za-z0-9_-]+\.js$' }).Count
$wkrZip = @($names | Where-Object { $_ -match '_worker\.js$' }).Count
$secZip = @($names | Where-Object { $_ -match '\.env(\.local|\.dev)?$|service_role|SERVICE_ROLE|RESEND_API|service-role|\.pem$|\.p8$|id_rsa$|\.key$|\.p12$' }).Count

Write-Output ("ZIP_19  => " + $zip)
Write-Output ("SIZE_19 => " + (Get-Item -LiteralPath $zip).Length)
Write-Output ("ENT_19  => " + $names.Count)
Write-Output ("ESM_19  => " + $esmZip)
Write-Output ("CJS_19  => " + $cjsZip)
Write-Output ("WKR_19  => " + $wkrZip)
Write-Output ("SEC_19  => " + $secZip)

if ($esmZip -eq 0) { throw "backup invalido: espelho ESM ausente no zip" }
if ($wkrZip  -eq 0) { throw "backup invalido: _worker.js ausente no zip" }
if ($secZip  -gt 0) { throw "backup invalido: segredo vazou no zip" }

Remove-Item -LiteralPath $stage -Recurse -Force
Write-Output 'BACKUP_19_VALIDO => TRUE'
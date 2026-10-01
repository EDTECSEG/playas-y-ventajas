# Gera RELATORIO-FUNCIONALIDADES.pdf a partir do .md, usando o Chrome headless.
#
# Por que Chrome: e o unico motor de PDF instalado na maquina (verificado por
# Get-Command em pandoc/wkhtmltopdf/chrome e pelos caminhos padrao de Edge e
# Chrome). Nao ha pandoc nem wkhtmltopdf, e o projeto nao tem pdfkit ou
# playwright em node_modules -- adicionar dependencia so para isto seria
#拉动 mais bytes no repo do que o proprio script.
#
# O CSS embutido tem que cobrir o que o relatorio usa: tabelas (secao 1), blockquote
# (a nota de data), listas aninhadas e codigo inline. Sem isso o PDF sai com a
# tabela quebrada em paginas separadas e o blockquote sem recuo.
#
# Uso: powershell -ExecutionPolicy Bypass -File scripts\.agent-scripts\md-to-pdf.ps1

param(
  [string]$Entrada = 'RELATORIO-FUNCIONALIDADES.md',
  [string]$Saida   = 'RELATORIO-FUNCIONALIDADES.pdf'
)

$ErrorActionPreference = 'Stop'

# O .md fica na raiz do repo, dois niveis acima deste script. Resolver pelo
# $PSScriptRoot e nao pelo diretorio de execucao: o script pode ser chamado de
# qualquer lugar e o cwd nao diz nada sobre onde o repo esta.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $root)) {
  throw "raiz do repo nao encontrada a partir de $PSScriptRoot"
}
Set-Location -LiteralPath $root

$candidatos = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$chrome = $candidatos | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) {
  throw 'Chrome ou Edge nao encontrado. Instale um dos dois ou ajuste $candidatos.'
}

$md = Get-Content -LiteralPath $Entrada -Raw -Encoding UTF8
# Conversao offline antes de montar o HTML: injetar o .md cru no <body> produz
# um PDF com "##" e "|" literais -- o Chrome nao interpreta Markdown.
$corpo = & (Join-Path $PSScriptRoot 'Convert-Markdown.ps1') -Markdown $md

$html = @"
<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Playas y Ventajas</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 19pt; border-bottom: 2px solid #14607a; padding-bottom: 5px; }
  h2 { font-size: 13.5pt; color: #14607a; margin-top: 20px; break-after: avoid; }
  h3 { font-size: 11.5pt; margin-top: 14px; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9.5pt;
          break-inside: avoid; }
  th, td { border: 1px solid #c8d4da; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #e8f0f3; }
  tr:nth-child(even) td { background: #f7fafb; }
  code { background: #eef2f4; padding: 1px 4px; border-radius: 3px;
         font: 9pt Consolas, monospace; }
  blockquote { border-left: 3px solid #14607a; margin: 10px 0; padding: 4px 12px;
               background: #f2f7f9; color: #444; }
  li { margin: 3px 0; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 18px 0; }
  table code { white-space: nowrap; }
</style></head>
<body>
$corpo
</body></html>
"@

$tmp = Join-Path $env:TEMP ("pyv-relatorio-" + [guid]::NewGuid().ToString('N').Substring(0,8) + '.html')
$tmpPdf = [IO.Path]::ChangeExtension($tmp, '.pdf')
[IO.File]::WriteAllText($tmp, $html, (New-Object Text.UTF8Encoding $false))

try {
  # Evita "Multiple targets are not supported in headless mode": passar cada
  # argumento como item separado (sem misturar aspas dentro do array quando
  # Start-Process recebe string[]). O caminho do arquivo precisa ser URI com
  # barras frontais e sem espacos extras.
  $uri = 'file:///' + $tmp.Replace('\', '/')
  # --user-data-dir tem que ser proprio e inexistente: sem ele o Chrome headless
  # tenta usar o perfil do usuario (possivelmente ja aberto) e aborta com
  # "Multiple targets are not supported in headless mode".
  $perfil = Join-Path $env:TEMP ('cr-pdf-' + [guid]::NewGuid().ToString('N').Substring(0,8))
  # --flag=valor tem de ser montado num unico token antes de entrar no array:
  # o operador + dentro de um literal de array do PowerShell separa em dois
  # itens ('--user-data-dir=', 'C:\...'), e o Chrome le o caminho solto como
  # um segundo alvo -> "Multiple targets are not supported in headless mode".
  $flagPerfil   = '--user-data-dir=' + $perfil
  $flagDestino  = '--print-to-pdf=' + $tmpPdf
  $args = @(
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    $flagPerfil,
    $flagDestino,
    '--no-pdf-header-footer',
    '--virtual-time-budget=10000',
    $uri
  )
  # Chamada direta com o operador &, nao Start-Process: o -ArgumentList junta
  # os itens com espaco e o Chrome passa a ler o caminho solto, ja que o valor
  # de --print-to-pdf= precisa chegar como argumento unico.
  #
  # O Chrome escreve "N bytes written to file ..." no STDERR mesmo em sucesso.
  # Com $ErrorActionPreference = 'Stop' o PowerShell transforma isso em
  # terminating error e mata o script antes do Copy-Item. Por isso o 2>&1 fica
  # capturado num array e o preference local volta a 'Continue' so na chamada.
  $ErrorActionPreference = 'Continue'
  # Nome diferente de $Saida de proposito: PowerShell e case-insensitive e
  # $saida sobrescreveria o parametro de destino com o texto de stderr.
  $logChrome = & $chrome @args 2>&1 | Out-String
  $ErrorActionPreference = 'Stop'

  if (-not (Test-Path -LiteralPath $tmpPdf)) {
    throw "Chrome nao gerou PDF.`n$logChrome"
  }
  Copy-Item -LiteralPath $tmpPdf -Destination $Saida -Force
  $kb = [math]::Round((Get-Item -LiteralPath $Saida).Length / 1KB, 1)
  "PDF gerado: $Saida ($kb kB) via $chrome"
}
finally {
  Remove-Item -LiteralPath $tmp, $tmpPdf -Force -ErrorAction SilentlyContinue
  if ($perfil) { Remove-Item -LiteralPath $perfil -Recurse -Force -ErrorAction SilentlyContinue }
}
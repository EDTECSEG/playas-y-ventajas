# Converte Markdown em HTML, offline, sem dependencia.
#
# Por que existe: o PDF do relatorio precisa sair correto mesmo sem internet.
# A alternativa seria carregar o marked de um CDN dentro do HTML e delegar a
# renderizacao a ele -- o artefato passaria a depender da rede no momento de
# gerar, e se o CDNuisse o documento sairia com "##" e "|" literais.
#
# O que este conversor cobre: o subconjunto de Markdown que o
# RELATORIO-FUNCIONALIDADES.md usa. Nao e um Markdown completo e nao deve ser
# tratado como um. Fica de fora de proposito:
#   - listas com mais de 2 niveis
#   - blocos de codigo cercados (```), o relatorio nao tem nenhum
#   - imagens e links com titulo
# Se algum dia aparecer, o sintoma e o texto sair cru no PDF, e a correcao e
# aqui -- nao no CSS.
#
# ORDEM DE PROCESSAMENTO (importante para nao quebrar):
#   1. protege blockquote e codigo inline com placeholders ASCII
#   2. divide em blocos (tabela/heading/lista/paragrafo) -- o "|" do codigo
#      inline ja esta protegido, senao viraria coluna
#   3. converte inline SO dentro de cada unidade de saida
#   4. restaura os placeholders
#
# Marcadores ASCII de proposito: numa versao anterior usavam-se \uE000 e isso
# quebrava em silencio -- [regex]::Escape([char]0xE000) devolve "?" em
# PowerShell 5.1, o padrao nunca casava e o codigo inline sumia do PDF.
#
# Param ($Markdown) -> string HTML.

param(
  [Parameter(Mandatory = $true)]
  [string]$Markdown
)

# ---------------------------------------------------------------------------
# 1) Protecao global
# ---------------------------------------------------------------------------

# Blockquote: o "> " precisa existir antes de qualquer transformacao, senao a
# regra de bloco nunca o reconhece. O conteudo fica guardado cru.
$quotes = New-Object System.Collections.Generic.List[string]
$texto = [regex]::Replace($Markdown, '(?m)^[ \t]*>[ \t]?(.*)$', {
  param($m)
  $quotes.Add($m.Groups[1].Value)
  return '%%QUOTE' + ($quotes.Count - 1) + '%%'
})

# Codigo inline: protegido antes da quebra de tabela, porque "|" dentro de
# `a | b` viraria coluna nova. Guarda o conteudo cru; o <code> e montado na
# etapa 3, junto com o resto do inline.
$codes = New-Object System.Collections.Generic.List[string]
$texto = [regex]::Replace($texto, '`([^`\n]+)`', {
  param($m)
  $codes.Add($m.Groups[1].Value)
  return '%%CODE' + ($codes.Count - 1) + '%%'
})

# ---------------------------------------------------------------------------
# 2) Conversao inline (usada por unidade de saida)
# ---------------------------------------------------------------------------

function Convert-Inline {
  param([string]$s, [System.Collections.Generic.List[string]]$codes)

  # "&" primeiro: trocar depois transformaria o "&amp;" ja existente em
  # "&amp;amp;".
  $r = $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')

  # Link antes de negrito/italico: o "[x]" de um link pode conter "*".
  $r = [regex]::Replace($r, '\[([^\]\n]+)\]\((https?://[^)\s]+|mailto:[^)\s]+)\)', '<a href="$2">$1</a>')

  # Negrito antes do italico: em "**a**" o asterisco duplo precisa casar inteiro.
  $r = [regex]::Replace($r, '\*\*([^*\n]+)\*\*', '<strong>$1</strong>')

  # Italico com guarda de nao-asterisco nao-word nos dois lados. Sem a guarda, o
  # "**" do negrito ja consumido deixaria sobra e o underscore de
  # "worker/main.js" viraria <em>.
  $r = [regex]::Replace($r, '(?<![\*\w])\*([^*\n]+)\*(?![\*\w])', '<em>$1</em>')
  $r = [regex]::Replace($r, '(?<![\*\w_])_([^_\n]+)_(?![\*\w_])', '<em>$1</em>')

  # Ultimo: restaura o codigo inline. Precisa ser depois do italico para que um
  # asterisco dentro de `code` nao vire <em>.
  $r = [regex]::Replace($r, '%%CODE(\d+)%%', {
    param($m) '<code>' + $codes[[int]$m.Groups[1].Value] + '</code>'
  })
  return $r
}

# ---------------------------------------------------------------------------
# 3) Blocos
# ---------------------------------------------------------------------------

$linhas = $texto -split "`r?`n"
$out = New-Object System.Collections.Generic.List[string]

# Pilha de listas: uma entrada por container aberto, com "li" dizendo se ha
# <li> sem fechar. Uma variavel unica de nivel nao daria conta -- "voltar um
# nivel" e "abrir uma sublista nova" mudam o mesmo numero e produzem HTML
# diferente.
$pilha = New-Object System.Collections.Generic.List[object]

function Close-Level([int]$ateNivel) {
  while ($pilha.Count -gt $ateNivel) {
    $topo = $pilha[$pilha.Count - 1]
    if ($topo.li) { $out.Add('</li>'); $topo.li = $false }
    $out.Add('</' + $topo.tipo + '>')
    $pilha.RemoveAt($pilha.Count - 1)
  }
}
function Close-All { Close-Level 0 }
function Push-Level([string]$tipo) {
  $out.Add('<' + $tipo + '>')
  $pilha.Add(@{ tipo = $tipo; li = $false })
}

for ($i = 0; $i -lt $linhas.Length; $i++) {
  $linha = $linhas[$i]

  if ([string]::IsNullOrWhiteSpace($linha)) { Close-All; continue }

  # --- tabela: exige a linha separadora imediatamente abaixo ---
  $prox = if ($i + 1 -lt $linhas.Length) { $linhas[$i + 1] } else { '' }
  if ($linha.Contains('|') -and $prox -match '^\s*\|?[\s:|-]*\|[\s:|-]*$') {
    Close-All
    $head = $linha.Trim().Trim('|').Split('|') | ForEach-Object {
      Convert-Inline $_.Trim() $codes
    }
    $out.Add('<table><thead><tr>' +
      (($head | ForEach-Object { '<th>' + $_ + '</th>' }) -join '') +
      '</tr></thead><tbody>')
    $i += 2   # consome cabecalho + separador
    while ($i -lt $linhas.Length -and $linhas[$i].Contains('|') -and -not [string]::IsNullOrWhiteSpace($linhas[$i])) {
      $cells = $linhas[$i].Trim().Trim('|').Split('|') | ForEach-Object {
        Convert-Inline $_.Trim() $codes
      }
      $out.Add('<tr>' + (($cells | ForEach-Object { '<td>' + $_ + '</td>' }) -join '') + '</tr>')
      $i++
    }
    $i--   # o for incrementa de novo
    $out.Add('</tbody></table>')
    continue
  }

  # --- blockquote ---
  if ($linha -match '^%%QUOTE(\d+)%%$') {
    Close-All
    $conteudo = Convert-Inline $quotes[[int]$Matches[1]] $codes
    $out.Add('<blockquote>' + $conteudo + '</blockquote>')
    continue
  }

  # --- heading ---
  if ($linha -match '^(#{1,6})\s+(.*)$') {
    Close-All
    $n = $Matches[1].Length
    $out.Add("<h$n>" + (Convert-Inline $Matches[2] $codes) + "</h$n>")
    continue
  }

  # --- hr ---
  if ($linha -match '^\s*(-{3,}|\*{3,}|_{3,})\s*$') {
    Close-All
    $out.Add('<hr>')
    continue
  }

  # --- item de lista ---
  # Recuo de 0, 2, 4 espacos -> nivel 1, 2, 3.
  if ($linha -match '^(\s*)([-*]|\d+\.)\s+(.*)$') {
    # Copiar de $Matches ANTES de qualquer outra expressao -match: o operador
    # -match reescreve $Matches com o ultimo casamento, e um teste como
    # ($Matches[2] -match '\d') apagaria $Matches[3]. Era o que fazia os itens
    # de lista ordenada sairem vazios, <li></li>.
    $recuo = $Matches[1]
    $marca = $Matches[2]
    $texto = $Matches[3]

    $nivel = [int][Math]::Floor($recuo.Length / 2) + 1
    $tipo  = if ($marca -match '\d') { 'ol' } else { 'ul' }
    $item  = Convert-Inline $texto $codes

    Close-Level $nivel   # sai de qualquer nivel mais fundo

    if ($pilha.Count -eq 0) {
      Push-Level $tipo
      # Markdown sem pai antes do subitem: preenche para nao gerar <ul> solto.
      while ($pilha.Count -lt $nivel) { Push-Level 'ul' }
    }
    elseif ($pilha.Count -lt $nivel) {
      # Desceu: o <li> do pai fica aberto e a sublista nasce dentro dele, que e
      # o HTML valido.
      Push-Level $pilha[$pilha.Count - 1].tipo
    }
    elseif ($tipo -ne $pilha[$pilha.Count - 1].tipo) {
      # Mesmo nivel, tipo diferente (ul dentro de ol): fecha e reabre.
      Close-Level ($pilha.Count - 1)
      Push-Level $tipo
    }

    $topo = $pilha[$pilha.Count - 1]
    if ($topo.li) { $out.Add('</li>') }
    $out.Add('<li>' + $item)
    $topo.li = $true
    continue
  }

  # --- paragrafo ---
  Close-All
  $out.Add('<p>' + (Convert-Inline $linha $codes) + '</p>')
}

Close-All
$out -join "`n"
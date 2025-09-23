param(
  [string]$Url = 'https://updates.threadsbooster.jp/nsis-web/Container%20Browser%20Web%20Setup%200.3.0.exe',
  [string]$Out = 'logs/web_setup_0.3.0.exe'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path logs | Out-Null
Write-Host "Downloading $Url -> $Out"
& "$env:SystemRoot\System32\curl.exe" -sSLo $Out $Url
if (-not (Test-Path $Out)) { Write-Error 'Download failed'; exit 2 }
Write-Host 'Downloaded'

$b = [IO.File]::ReadAllBytes($Out)
$sAscii = [System.Text.Encoding]::ASCII.GetString($b)
$sUtf8  = [System.Text.Encoding]::UTF8.GetString($b)
$sUtf16 = [System.Text.Encoding]::Unicode.GetString($b)

$patterns = @(
  'https?://[A-Za-z0-9\-\._/~:%\?=&]+' ,
  'nsis-web/[A-Za-z0-9\-\._% ]+' ,
  'container-browser[0-9A-Za-z\-\._]*?\.nsis\.7z',
  'latest.yml'
)

$found = @{}
foreach ($p in $patterns) {
  $m = [regex]::Matches($sAscii, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  foreach ($x in $m) { $found[$x.Value] = $true }
  $m = [regex]::Matches($sUtf8, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  foreach ($x in $m) { $found[$x.Value] = $true }
  $m = [regex]::Matches($sUtf16, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  foreach ($x in $m) { $found[$x.Value] = $true }
}

# Search for UTF-16LE byte sequence for 'latest.yml'
$needle = [System.Text.Encoding]::Unicode.GetBytes('latest.yml')
$idx = -1
for ($i = 0; $i -le $b.Length - $needle.Length; $i++) {
  $match = $true
  for ($j = 0; $j -lt $needle.Length; $j++) { if ($b[$i + $j] -ne $needle[$j]) { $match = $false; break } }
  if ($match) { $idx = $i; break }
}
if ($idx -ge 0) { $found["(utf16)latest.yml at index $idx"] = $true }

Write-Host 'Found items:'
if ($found.Keys.Count -eq 0) { Write-Host '<none>' } else { $found.Keys | Sort-Object | ForEach-Object { Write-Host $_ } }

# Save a cleaned ASCII excerpt for inspection
$outtxt = 'logs/web_setup_strings.txt'
$clean = $sAscii -replace '[\x00-\x1F]', ''
Set-Content -LiteralPath $outtxt -Value $clean -Encoding ascii
Write-Host "Wrote ASCII excerpt to $outtxt"

exit 0



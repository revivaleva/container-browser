param(
  [string]$ExtractDir = 'tmp\pkg'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$env:AWS_PAGER = ''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$log = Join-Path 'logs' 'check_extracted_pkg.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)\nExtractDir: $ExtractDir") -Encoding utf8

if (-not (Test-Path -LiteralPath $ExtractDir)) {
  Add-Content -Path $log -Value "Directory not found: $ExtractDir"
  Write-Host "Directory not found: $ExtractDir"; exit 2
}

$items = Get-ChildItem -Path $ExtractDir -Recurse -ErrorAction SilentlyContinue
$hits = $items | Where-Object { $_.Name -ieq 'latest.yml' -or $_.Name -like '*.nsis.7z' }
if (-not $hits -or $hits.Count -eq 0) {
  Add-Content -Path $log -Value 'No latest.yml or *.nsis.7z found in extracted package'
  Write-Host 'No latest.yml or *.nsis.7z found in extracted package'; exit 0
}

foreach ($f in $hits) {
  Add-Content -Path $log -Value ("FOUND: " + $f.FullName)
  Write-Host "FOUND: $($f.FullName)"
  if ($f.Name -ieq 'latest.yml') {
    Add-Content -Path $log -Value '--- latest.yml content ---'
    Write-Host '--- latest.yml content ---'
    Get-Content -Raw $f.FullName | Tee-Object -FilePath $log -Append | Out-Host
    Write-Host '--- end ---'
    Add-Content -Path $log -Value '--- end ---'
  }
  if ($f.Name -like '*.nsis.7z') {
    Add-Content -Path $log -Value ('FOUND nsis.7z: ' + $f.FullName)
    Write-Host ('FOUND nsis.7z: ' + $f.FullName)
  }
}

Write-Host 'Done.'
Add-Content -Path $log -Value ('End: ' + (Get-Date -Format o))



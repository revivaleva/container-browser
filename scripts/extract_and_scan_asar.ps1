<#
Extract tmp/pkg/resources/app.asar (if present) and scan extracted files for update-related strings.
Writes logs/log findings to logs/asar_scan.log
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs,tmp\asar_out | Out-Null
$log = Join-Path 'logs' 'asar_scan.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

$asarPath = Join-Path (Join-Path (Get-Location) 'tmp\pkg\resources') 'app.asar'
if (-not (Test-Path -LiteralPath $asarPath)) {
  Add-Content -Path $log -Value ("app.asar not found: $asarPath")
  Write-Host "app.asar not found: $asarPath"
  exit 2
}

Write-Host "Found app.asar: $asarPath"
Add-Content -Path $log -Value ("Found app.asar: $asarPath")

$outDir = Join-Path (Get-Location) 'tmp\asar_out'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $outDir
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Prefer npx asar
$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  Add-Content -Path $log -Value 'Using npx to extract asar'
  Write-Host 'Using npx to extract asar (this may take a few seconds)'
  npx asar extract $asarPath $outDir 2>&1 | Tee-Object -FilePath $log -Append
} else {
  $asarCmd = Get-Command asar -ErrorAction SilentlyContinue
  if ($asarCmd) {
    Add-Content -Path $log -Value 'Using asar executable to extract'
    & $asarCmd.Source extract $asarPath $outDir 2>&1 | Tee-Object -FilePath $log -Append
  } else {
    Add-Content -Path $log -Value 'Neither npx nor asar found in PATH; cannot extract app.asar'
    Write-Host 'Neither npx nor asar found in PATH; cannot extract app.asar'
    exit 3
  }
}

Add-Content -Path $log -Value 'Extraction finished. Scanning extracted files for update strings'

# Search for patterns
$patterns = @('latest.yml','updates.threadsbooster.jp','nsis-web','\.nsis\.7z','app-update.yml')
$matches = @()
foreach ($p in $patterns) {
  try {
    $ms = Select-String -Path (Join-Path $outDir '*') -Pattern $p -SimpleMatch -AllMatches -ErrorAction SilentlyContinue
    if ($ms) { $matches += $ms }
  } catch {}
}

if ($matches.Count -eq 0) {
  Add-Content -Path $log -Value 'No matches found for update-related strings in extracted asar'
  Write-Host 'No matches found for update-related strings in extracted asar'
} else {
  Add-Content -Path $log -Value 'Matches found:'
  foreach ($m in $matches) {
    $line = ($m.Path + ':' + $m.LineNumber + ':' + $m.Line.Trim())
    Add-Content -Path $log -Value $line
    Write-Host $line
  }
}

Add-Content -Path $log -Value ('End: ' + (Get-Date -Format o))
Write-Host "Done. Log: $log"



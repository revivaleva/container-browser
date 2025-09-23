<#
Extract tmp/pkg_explicit/resources/app.asar and scan extracted files for update-related strings.
Outputs results to logs/asar_explicit_scan.log and prints matches.
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs,tmp\asar_out_explicit | Out-Null
$log = Join-Path 'logs' 'asar_explicit_scan.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

$asarPath = Join-Path (Join-Path (Get-Location) 'tmp\pkg_explicit\resources') 'app.asar'
if (-not (Test-Path -LiteralPath $asarPath)) {
  Add-Content -Path $log -Value ("app.asar not found: $asarPath")
  Write-Host "app.asar not found: $asarPath"; exit 2
}

Write-Host "Found app.asar: $asarPath"
Add-Content -Path $log -Value ("Found app.asar: $asarPath")

$outDir = Join-Path (Get-Location) 'tmp\asar_out_explicit'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $outDir
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# extract with npx asar or asar CLI
$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  Add-Content -Path $log -Value 'Using npx to extract asar'
  Write-Host 'Using npx to extract asar'
  & npx asar extract $asarPath $outDir 2>&1 | Tee-Object -FilePath $log -Append
} else {
  $asarCmd = Get-Command asar -ErrorAction SilentlyContinue
  if ($asarCmd) {
    Add-Content -Path $log -Value 'Using asar executable to extract'
    & $asarCmd.Source extract $asarPath $outDir 2>&1 | Tee-Object -FilePath $log -Append
  } else {
    Add-Content -Path $log -Value 'Neither npx nor asar found; cannot extract app.asar'
    Write-Host 'Neither npx nor asar found; cannot extract app.asar'; exit 3
  }
}

Add-Content -Path $log -Value 'Extraction finished. Scanning extracted asar files'
Write-Host 'Extraction finished. Scanning extracted asar files'

$patterns = @('latest.yml','updates.threadsbooster.jp','nsis-web','\.nsis\.7z','app-update.yml')
$foundAny = $false
foreach ($p in $patterns) {
  Add-Content -Path $log -Value ("Searching for: $p")
  Write-Host ('Searching: ' + $p)
  try {
    $ms = Select-String -Path (Join-Path $outDir '**\*') -Pattern $p -AllMatches -ErrorAction SilentlyContinue
    if ($ms) {
      $foundAny = $true
      foreach ($m in $ms) {
        $line = ($m.Path + ':' + $m.LineNumber + ':' + $m.Line.Trim())
        Add-Content -Path $log -Value $line
        Write-Host $line
      }
    }
  } catch {
    $msg = $_.Exception.Message -replace "`r`n", ' '
    Add-Content -Path $log -Value ("Search error for pattern ${p}: " + $msg)
  }
}

if (-not $foundAny) { Add-Content -Path $log -Value 'No update-related strings found in extracted asar'; Write-Host 'No update-related strings found' }

Add-Content -Path $log -Value ('End: ' + (Get-Date -Format o))
Write-Host 'Done. Log:' $log



param(
  [string]$PackagePath = ''
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$logFull = Join-Path 'logs' 'pkg_list_full.log'
$logFiltered = Join-Path 'logs' 'pkg_list_filtered.log'
Set-Content -Path $logFull -Value ("Start: $(Get-Date -Format o)") -Encoding utf8
Set-Content -Path $logFiltered -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

if (-not $PackagePath) {
  # search typical locations
  $candidates = @()
  try { $candidates += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA '') -Recurse -Filter 'package.7z' -ErrorAction SilentlyContinue } catch {}
  try { $candidates += Get-ChildItem -Path (Join-Path (Get-Location) 'tmp') -Recurse -Filter 'package.7z' -ErrorAction SilentlyContinue } catch {}
  if (-not $candidates -or $candidates.Count -eq 0) { Write-Host 'No package.7z candidates found'; Add-Content -Path $logFull -Value 'No package.7z candidates found'; exit 2 }
  $pkg = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $PackagePath = $pkg.FullName
}

if (-not (Test-Path -LiteralPath $PackagePath)) { Write-Host 'Package not found:' $PackagePath; Add-Content -Path $logFull -Value ('Package not found: ' + $PackagePath); exit 3 }

# locate 7z
$seven = Get-Command 7z -ErrorAction SilentlyContinue
if (-not $seven) {
  $std = @('C:\\Program Files\\7-Zip\\7z.exe','C:\\Program Files (x86)\\7-Zip\\7z.exe')
  foreach ($p in $std) { if (Test-Path $p) { $seven = New-Object PSObject -Property @{ Source = $p }; break } }
}
if (-not $seven) { Write-Host '7z not found'; Add-Content -Path $logFull -Value '7z not found'; exit 4 }

$sevenPath = $seven.Source
Write-Host 'Using 7z:' $sevenPath
Add-Content -Path $logFull -Value ('Using 7z: ' + $sevenPath)

$out = & $sevenPath l $PackagePath 2>&1
$out | Tee-Object -FilePath $logFull -Append | Out-Null

$filter = $out | Select-String -Pattern 'resources','app-update.yml','app.asar','latest.yml','nsis.7z' -SimpleMatch -CaseSensitive:$false
if ($filter) { $filter | Tee-Object -FilePath $logFiltered -Append | Out-Host } else { Write-Host 'No matching entries found; full listing saved to' $logFull }

Add-Content -Path $logFull -Value ('End: ' + (Get-Date -Format o))
Add-Content -Path $logFiltered -Value ('End: ' + (Get-Date -Format o))



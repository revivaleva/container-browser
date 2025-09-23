param(
  [string]$Pkg = 'C:\Users\revival\AppData\Local\container-browser-updater\package.7z'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$env:AWS_PAGER = ''

New-Item -ItemType Directory -Force -Path logs,tmp | Out-Null
$log = Join-Path 'logs' 'package_extraction.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)\nPackage: $Pkg") -Encoding utf8

if (-not (Test-Path -LiteralPath $Pkg)) {
  Add-Content -Path $log -Value "Package not found: $Pkg"
  Write-Host "Package not found: $Pkg"; exit 2
}

# locate 7z
$seven = $null
try { $cmd = Get-Command 7z -ErrorAction SilentlyContinue; if ($cmd) { $seven = $cmd.Source } } catch {}
if (-not $seven) {
  $cands = @("C:\\Program Files\\7-Zip\\7z.exe","C:\\Program Files (x86)\\7-Zip\\7z.exe")
  foreach ($p in $cands) { if (Test-Path $p) { $seven = $p; break } }
}

if ($seven) {
  Add-Content -Path $log -Value "7z found: $seven"
  Add-Content -Path $log -Value "Listing archive..."
  & $seven l $Pkg 2>&1 | Tee-Object -FilePath $log -Append
  $outdir = Join-Path (Get-Location) 'tmp\pkg'
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $outdir
  New-Item -ItemType Directory -Force -Path $outdir | Out-Null
  Add-Content -Path $log -Value "Extracting to $outdir"
  & $seven x $Pkg -o$outdir -y 2>&1 | Tee-Object -FilePath $log -Append
  Add-Content -Path $log -Value "Search extracted files for latest.yml and *.nsis.7z"
  Get-ChildItem -Path $outdir -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -ieq 'latest.yml') { Add-Content -Path $log -Value ("FOUND latest.yml: " + $_.FullName) }
    if ($_.Name -like '*.nsis.7z') { Add-Content -Path $log -Value ("FOUND nsis.7z: " + $_.FullName) }
  }
  Get-Content -Path $log -Tail 200 | Write-Host
  exit 0
} else {
  Add-Content -Path $log -Value "7z not found; performing binary search in archive for keywords"
  $b = [IO.File]::ReadAllBytes($Pkg)
  $s = [System.Text.Encoding]::ASCII.GetString($b)
  $found = @()
  if ($s.Contains('latest.yml')) { $found += 'latest.yml (ascii found)' }
  if ($s.IndexOf('nsis.7z', [System.StringComparison]::InvariantCultureIgnoreCase) -ge 0) { $found += '.nsis.7z (ascii found)' }
  if ($found.Count -eq 0) { Add-Content -Path $log -Value 'No ASCII hits for latest.yml or nsis.7z in binary' } else { $found | ForEach-Object { Add-Content -Path $log -Value "HIT: $_" } }
  Get-Content -Path $log -Tail 200 | Write-Host
  exit 0
}



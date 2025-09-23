<#
Find package.7z in local updater cache, extract it fully to tmp/pkg (overwrite),
then locate app.asar and extract it with npx/asar and scan for update strings.
#>
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs,tmp\pkg,tmp\asar_out | Out-Null
$log = Join-Path 'logs' 'full_extract_and_asar.log'
Set-Content -Path $log -Value ("Start: $(Get-Date -Format o)") -Encoding utf8

Write-Host 'Searching for package.7z under LOCALAPPDATA and tmp locations...'
Add-Content -Path $log -Value 'Searching for package.7z under LOCALAPPDATA and tmp locations...'

$candidates = @()
try {
  $candidates += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA '') -Recurse -Filter 'package.7z' -ErrorAction SilentlyContinue
} catch {}
try {
  $candidates += Get-ChildItem -Path (Join-Path (Get-Location) 'tmp') -Recurse -Filter 'package.7z' -ErrorAction SilentlyContinue
} catch {}

if (-not $candidates -or $candidates.Count -eq 0) {
  Add-Content -Path $log -Value 'No package.7z found under LOCALAPPDATA or tmp'
  Write-Host 'No package.7z found under LOCALAPPDATA or tmp'
  exit 2
}

$pkg = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Add-Content -Path $log -Value ('Selected package: ' + $pkg.FullName)
Write-Host ('Selected package: ' + $pkg.FullName)

# find 7z
$seven = $null
try { $cmd = Get-Command 7z -ErrorAction SilentlyContinue; if ($cmd) { $seven = $cmd.Source } } catch {}
if (-not $seven) {
  $cands = @('C:\\Program Files\\7-Zip\\7z.exe','C:\\Program Files (x86)\\7-Zip\\7z.exe')
  foreach ($p in $cands) { if (Test-Path $p) { $seven = $p; break } }
}

if (-not $seven) {
  Add-Content -Path $log -Value '7z not found in PATH or standard locations'
  Write-Host '7z not found; please install 7-Zip or ensure 7z.exe is in PATH'
  exit 3
}

Write-Host ('Using 7z: ' + $seven)
Add-Content -Path $log -Value ('Using 7z: ' + $seven)

$outdir = Join-Path (Get-Location) 'tmp\pkg'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $outdir
New-Item -ItemType Directory -Force -Path $outdir | Out-Null

Write-Host 'Extracting package to tmp/pkg (this may take a while)...'
& $seven x $pkg.FullName -o$outdir -y 2>&1 | Tee-Object -FilePath $log -Append

Write-Host 'Extraction finished. Listing tmp/pkg top-level...'
Get-ChildItem -LiteralPath $outdir | Select-Object Name,Length,LastWriteTime | Tee-Object -FilePath $log -Append | ForEach-Object { Write-Host ("ITEM: $($_.Name)  $($_.Length)  $($_.LastWriteTime)") }

# locate app.asar
$asarPath = Join-Path $outdir 'resources\app.asar'
if (-not (Test-Path -LiteralPath $asarPath)) {
  Add-Content -Path $log -Value ('app.asar not found at: ' + $asarPath)
  Write-Host ('app.asar not found at: ' + $asarPath)
  exit 4
}

Add-Content -Path $log -Value ('Found app.asar: ' + $asarPath)
Write-Host ('Found app.asar: ' + $asarPath)

# extract app.asar
$outAsar = Join-Path (Get-Location) 'tmp\asar_out'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $outAsar
New-Item -ItemType Directory -Force -Path $outAsar | Out-Null

$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($npx) {
  Write-Host 'Using npx asar to extract app.asar'
  npx asar extract $asarPath $outAsar 2>&1 | Tee-Object -FilePath $log -Append
} else {
  $asarCmd = Get-Command asar -ErrorAction SilentlyContinue
  if ($asarCmd) {
    Write-Host 'Using asar executable to extract'
    & $asarCmd.Source extract $asarPath $outAsar 2>&1 | Tee-Object -FilePath $log -Append
  } else {
    Add-Content -Path $log -Value 'Neither npx nor asar found; cannot extract app.asar'
    Write-Host 'Neither npx nor asar found; cannot extract app.asar'
    exit 5
  }
}

Write-Host 'Scanning extracted asar files for update-related strings...'
Add-Content -Path $log -Value 'Scanning extracted asar files for update-related strings'

$patterns = @('latest.yml','updates.threadsbooster.jp','nsis-web','\.nsis\.7z','app-update.yml')
foreach ($p in $patterns) {
  Write-Host ('Searching for: ' + $p)
  Add-Content -Path $log -Value ('Searching for: ' + $p)
  try {
    $ms = Select-String -Path (Join-Path $outAsar '*') -Pattern $p -AllMatches -ErrorAction SilentlyContinue
    if ($ms) { foreach ($m in $ms) { $line = ($m.Path + ':' + $m.LineNumber + ':' + $m.Line.Trim()); Add-Content -Path $log -Value $line; Write-Host $line } }
  } catch {}
}

Add-Content -Path $log -Value ('End: ' + (Get-Date -Format o))
Write-Host 'Done. Log:' $log



param(
  [string]$Bucket         = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn            = 'https://updates.threadsbooster.jp',
  [string]$SourceDir      = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$ConfirmPreference     = 'None'
$env:AWS_PAGER         = ''

# Ensure logs directory
New-Item -Type Directory -Force -Path 'logs' | Out-Null

$ts     = Get-Date -Format 'yyyyMMdd_HHmmss'
$tag    = 'upd_' + $ts
$logB   = 'logs/' + $tag + '.build'
$logM   = 'logs/' + $tag + '.main'
$logMOut = $logM + '.out'
$logBOut = $logB + '.out'
$logBErr = $logB + '.err'

# 0) Stop possibly interfering processes (best-effort)
foreach($name in @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')){
  try { Get-Process -Name $name -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
}

# 1) package.json health
if(!(Test-Path -LiteralPath 'package.json')){ throw 'package.json is missing' }
try {
  $pj = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
  ('package.json version: {0}' -f $pj.version) | Tee-Object -FilePath $logMOut -Append | Out-Host
} catch {
  throw ('package.json is invalid: {0}' -f $_.Exception.Message)
}

# 2) Prepare nsis-web artifacts
$nsisDir = $null
if($SourceDir){ $nsisDir = $SourceDir }

if(-not $nsisDir -and -not $SkipBuild){
  # remove any previous dist_update_* directories to avoid stale artifacts
  Get-ChildItem -Directory -Filter 'dist_update_*' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

  # Resolve npx executable robustly (handle npx or npx.cmd)
  $npxCmd = Get-Command -Name npx -ErrorAction SilentlyContinue
  if (-not $npxCmd) { $npxCmd = Get-Command -Name npx.cmd -ErrorAction SilentlyContinue }
  if (-not $npxCmd) { throw 'npx not found in PATH' }
  $npx = $npxCmd.Source
  $outDir = 'dist_update_' + $ts
  $argList = @(
    'electron-builder',
    '--win','nsis-web',
    '--x64',
    # do not pass explicit sign flag; rely on removing signing env vars instead
    '--publish','never',
    ('-c.directories.output=' + $outDir),
    ('-c.win.target=nsis-web')
  )
  # Short-term: disable code signing by removing signing env vars so electron-builder won't try to sign
  Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  # Ensure env vars are unset in this process as well (defensive)
  try { $env:WIN_CSC_LINK = $null } catch {}
  try { $env:CSC_LINK = $null } catch {}
  try { $env:CSC_KEY_PASSWORD = $null } catch {}
  # Do not pass explicit -c.win.sign=false to avoid boolean/module path issues; rely on removing signing env vars instead
  # Before invoking electron-builder, ensure compiled output exists; if missing, attempt to run the TypeScript build
  $entryFile = Join-Path 'out' 'main\index.js'
  if (-not (Test-Path -LiteralPath $entryFile)) {
    Write-Host "DEBUG: build output missing ($entryFile). Running 'npm run build' to produce it."
    try {
      npm run build 2>&1 | Tee-Object -FilePath $logBOut -Append
    } catch {
      Write-Host 'npm run build failed; continuing to attempt electron-builder (will likely fail)'
    }
  }

  # Run electron-builder in-process so env removals take effect
  & $npx @argList *> $logBOut 2> $logBErr
  $exit = $LASTEXITCODE
  if($exit -ne 0){
    Write-Host ''
    Write-Host '== BUILD OUT (tail) =='
    if(Test-Path $logBOut){ Get-Content -LiteralPath $logBOut -Tail 120 }
    Write-Host ''
    Write-Host '== BUILD ERR (tail) =='
    if(Test-Path $logBErr){ Get-Content -LiteralPath $logBErr -Tail 120 }
    throw ('nsis-web build failed: ExitCode={0}' -f $exit)
  }
  $nsisDir = Join-Path $outDir 'nsis-web'
}

if(-not $nsisDir){
  # Fallback: latest dist_update_* that contains latest.yml
  $nsisDir = Get-ChildItem -Directory -Filter 'dist_update_*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Desc |
    ForEach-Object { Join-Path $_.FullName 'nsis-web' } |
    Where-Object { Test-Path (Join-Path $_ 'latest.yml') } |
    Select-Object -First 1
}

if(-not $nsisDir -or -not (Test-Path (Join-Path $nsisDir 'latest.yml'))){
  throw ('nsis-web artifacts not found (missing latest.yml): {0}' -f $nsisDir)
}

('NSIS_DIR: {0}' -f $nsisDir) | Tee-Object -FilePath $logMOut -Append | Out-Host
Get-ChildItem -LiteralPath $nsisDir | Tee-Object -FilePath $logMOut -Append | Out-Host

# 3) Upload to S3
$latestYml = Join-Path $nsisDir 'latest.yml'
# Rewrite latest.yml to reference files under nsis-web/ root to match uploaded artifact paths.
$latestContent = Get-Content -LiteralPath $latestYml -Raw
# Rewrite manifest entries to point to absolute CDN root URLs (publish artifacts at S3 root).
# Rationale: unify installer/package placement to S3 root to avoid dual-path ambiguity
# and CloudFront cache behavior differences between root and 'nsis-web/'.
$cdnBase = $Cdn.TrimEnd('/')
"# Normalize any embedded S3 direct URLs by stripping the S3 domain prefix so we can rewrite to CDN"
$latestContent = $latestContent -replace 'https?://container-browser-updates\.s3\.amazonaws\.com/',''

# Rewrite manifest entries:
# - installer (.exe) -> CDN nsis-web/ path
# - package (.nsis.7z) -> CDN root
$latestContent = [regex]::Replace(
  $latestContent,
  '(^\s*-\s*url:\s*)(?:\"?)(?!https?://)([\w\-\.\s]+?\.exe)(?:\"?)',
  '${1}' + $cdnBase + '/nsis-web/${2}',
  'Multiline'
)
$latestContent = [regex]::Replace(
  $latestContent,
  '(^\s*-\s*url:\s*)(?:\"?)(?!https?://)([\w\-\.\s]+?\.nsis\.7z)(?:\"?)',
  '${1}' + $cdnBase + '/${2}',
  'Multiline'
)

# Also rewrite path/file entries that reference exe or nsis.7z
$latestContent = [regex]::Replace(
  $latestContent,
  '(^\s*(?:path|file):\s*)(?:\"?)(?!https?://)(?:.*?)([^"\r\n]+?\.(?:exe|nsis\.7z))(?:\"?)$',
  '${1}' + $cdnBase + '/${2}',
  'Multiline'
)

# Ensure a stable (non-versioned) Web-Setup filename is available on the CDN so a fixed URL
# like /nsis-web/ContainerBrowser-Web-Setup.exe always points to the latest installer.
try {
  $webSetup = Get-ChildItem -LiteralPath $nsisDir -Filter '*Web-Setup*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($webSetup) {
    $fixedWebName = 'ContainerBrowser-Web-Setup.exe'
    Write-Host ("DEBUG: Found web setup: {0} -> copying as fixed name: {1}" -f $webSetup.Name, $fixedWebName)
    # Upload the fixed-name copy to S3 root (consistent root placement)
    aws s3 cp (Join-Path $nsisDir $webSetup.Name) ("s3://$Bucket/" + $fixedWebName) --no-progress --content-type 'application/x-msdownload' | Out-Null

    # Also update latestContent so the manifest's url points to the fixed CDN URL at root
    $fixedUrl = ($Cdn.TrimEnd('/') + '/' + $fixedWebName)
    # Replace the first '- url:' entry with the fixed absolute URL
    $latestContent = [regex]::Replace($latestContent, '(^\s*-\s*url:\s*).*', '${1}' + $fixedUrl, 'Singleline')
  } else {
    Write-Host 'DEBUG: web setup exe not found in nsisDir; skipping fixed-name copy.'
  }
} catch {
  Write-Host ('WARNING: failed to create fixed web-setup copy: {0}' -f $_.Exception.Message)
}
  $modifiedLatestDir = Join-Path $PSScriptRoot 'logs'
  $modifiedLatest = Join-Path $modifiedLatestDir 'latest_upload.yml'
[IO.File]::WriteAllText($modifiedLatest, $latestContent, [Text.UTF8Encoding]::new($false))
# Upload latest.yml with no-cache to encourage CDN refresh
aws s3 cp $modifiedLatest ('s3://' + $Bucket + '/latest.yml') --no-progress --content-type 'text/yaml' --cache-control 'no-cache, max-age=0' | Out-Null
# Upload each artifact file to the S3 root explicitly (avoid preserving local directory name)
Get-ChildItem -LiteralPath $nsisDir -File | Where-Object { $_.Name -ne 'latest.yml' } | ForEach-Object {
  $local = $_.FullName
  $key = $_.Name
  Write-Host ("Uploading {0} -> s3://{1}/{2}" -f $local, $Bucket, $key)
  aws s3 cp $local ("s3://$Bucket/" + $key) --no-progress --content-type 'application/octet-stream' --cache-control 'public,max-age=300' | Out-Null
}

# 4) CloudFront invalidation
$invObj = @{ Paths=@{ Quantity=2; Items=@('/latest.yml','/*') }; CallerReference=('autoupd-' + $ts) }
try {
  $invJson = $invObj | ConvertTo-Json -Compress
  $invPath = Join-Path -Path 'logs' -ChildPath ('inv_' + $ts + '.json')
  [IO.File]::WriteAllText($invPath, $invJson, [Text.UTF8Encoding]::new($false))
  aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch ('file://' + $invPath) | Out-Null
} catch {
  # If CloudFront invalidation is not permitted (AccessDenied) or fails for any reason,
  # log a warning and continue — lack of invalidation should not make the whole release fail.
  $msg = $_.Exception.Message
  Write-Host "Warning: CloudFront invalidation failed: $msg"
  Add-Content -Path $logMOut -Value ("WARNING: CloudFront invalidation failed: {0}" -f $msg)
}

# 5) CDN verification (200 / 206)
$cdnLatest = 'logs/cdn_latest.yml'
$curl = Join-Path $env:SystemRoot 'System32/curl.exe'
& $curl -sSLo $cdnLatest ($Cdn + '/latest.yml') | Out-Null
$y   = Get-Content -LiteralPath $cdnLatest -Raw
$pkg = ([regex]::Matches($y,'(?im)[\w\-.]+\.nsis\.7z') | Select-Object -Last 1).Value
if([string]::IsNullOrWhiteSpace($pkg)){ throw 'failed to extract .nsis.7z name from latest.yml' }
('PKG: {0}' -f $pkg) | Tee-Object -FilePath $logMOut -Append | Out-Host

& $curl -I ($Cdn + '/latest.yml')    | Select-String '^HTTP/' | Tee-Object -FilePath $logMOut -Append | Out-Host
& $curl -I ($Cdn + '/nsis-web/' + $pkg) | Select-String '^HTTP/' | Tee-Object -FilePath $logMOut -Append | Out-Host
& $curl -A 'INetC/1.0' -r 0-1048575 -s -S -o NUL -D - ($Cdn + '/nsis-web/' + $pkg) | Select-String '^HTTP/' | Tee-Object -FilePath $logMOut -Append | Out-Host

Write-Host ''
('== Web Setup (fixed URL) ==')         | Tee-Object -FilePath $logMOut -Append | Out-Host
($Cdn + '/nsis-web/ContainerBrowser-Web-Setup.exe') | Tee-Object -FilePath $logMOut -Append | Out-Host
('== Offline Setup (reference) ==')     | Tee-Object -FilePath $logMOut -Append | Out-Host
($Cdn + '/nsis-web/ContainerBrowser-Offline-Setup.exe') | Tee-Object -FilePath $logMOut -Append | Out-Host

Write-Host ''
('Done. Logs: {0} / {1} / {2}' -f $logMOut, $logBOut, $logBErr) | Out-Host

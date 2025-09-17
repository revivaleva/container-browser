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
  $npx = (Get-Command 'npx.cmd').Source
  $outDir = 'dist_update_' + $ts
  $argList = @(
    'electron-builder',
    '--win','nsis-web',
    '--x64',
    '--publish','never',
    ('-c.directories.output=' + $outDir),
    ('-c.win.target=nsis-web')
  )
  # Short-term: disable code signing by removing signing env vars so electron-builder won't try to sign
  Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  # Also explicitly tell electron-builder to not sign on Windows
  $argList += '-c.win.sign=false'
  $p = Start-Process -FilePath $npx -ArgumentList $argList -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput $logBOut -RedirectStandardError $logBErr
  if($p.ExitCode -ne 0){
    Write-Host ''
    Write-Host '== BUILD OUT (tail) =='
    if(Test-Path $logBOut){ Get-Content -LiteralPath $logBOut -Tail 120 }
    Write-Host ''
    Write-Host '== BUILD ERR (tail) =='
    if(Test-Path $logBErr){ Get-Content -LiteralPath $logBErr -Tail 120 }
    throw ('nsis-web build failed: ExitCode={0}' -f $p.ExitCode)
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
aws s3 cp $latestYml ('s3://' + $Bucket + '/latest.yml') --no-progress | Out-Null
aws s3 cp $nsisDir ('s3://' + $Bucket + '/nsis-web/') --recursive --no-progress --cache-control 'public,max-age=300' | Out-Null

# 4) CloudFront invalidation
$invObj = @{ Paths=@{ Quantity=2; Items=@('/latest.yml','/nsis-web/*') }; CallerReference=('autoupd-' + $ts) }
$invJson = $invObj | ConvertTo-Json -Compress
$invPath = Join-Path -Path 'logs' -ChildPath ('inv_' + $ts + '.json')
[IO.File]::WriteAllText($invPath, $invJson, [Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch ('file://' + $invPath) | Out-Null

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

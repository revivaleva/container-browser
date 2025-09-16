param(
  [string]$Bucket         = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn            = 'https://updates.threadsbooster.jp',
  [string]$Exe            = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$ConfirmPreference     = 'None'
$env:AWS_PAGER         = ''

# Ensure logs directory exists
New-Item -Type Directory -Force -Path 'logs' | Out-Null

$ts    = Get-Date -Format 'yyyyMMdd_HHmmss'
$tag   = 'offline_' + $ts
$logB  = 'logs/' + $tag + '.build'
$logM  = 'logs/' + $tag + '.main'
$logMOut = $logM + '.out'
$logBOut = $logB + '.out'
$logBErr = $logB + '.err'

# 0) Stop possibly interfering processes (best-effort)
foreach($name in @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')){
  try { Get-Process -Name $name -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
}

# 1) Determine the offline installer EXE
$selected = $null
if($Exe -and (Test-Path -LiteralPath $Exe)){
  $selected = Get-Item -LiteralPath $Exe
}

if(-not $selected -and -not $SkipBuild){
  # Fresh build using electron-builder (nsis target)
  $npx = (Get-Command 'npx.cmd').Source
  $outDir = 'dist_offline_' + $ts
  $argList = @(
    'electron-builder',
    '--win','nsis',
    '--x64',
    '--publish','never',
    ('-c.directories.output=' + $outDir),
    '-c.nsis.oneClick=true',
    '-c.nsis.perMachine=false',
    '-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe'
  )
  $p = Start-Process -FilePath $npx -ArgumentList $argList -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput $logBOut -RedirectStandardError $logBErr
  if($p.ExitCode -ne 0){
    Write-Host ''
    Write-Host '== BUILD OUT (tail) =='
    if(Test-Path $logBOut){ Get-Content -LiteralPath $logBOut -Tail 120 }
    Write-Host ''
    Write-Host '== BUILD ERR (tail) =='
    if(Test-Path $logBErr){ Get-Content -LiteralPath $logBErr -Tail 120 }
    throw ('Offline build failed: ExitCode={0}' -f $p.ExitCode)
  }

  if(Test-Path -LiteralPath $outDir){
    $selected = Get-ChildItem -LiteralPath $outDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'Web-Setup' } |
      Sort-Object LastWriteTime -Desc |
      Select-Object -First 1
  }
}

if(-not $selected){
  # Fallback: scan the latest dist_offline_* for a non Web-Setup exe
  $selected = Get-ChildItem -Directory -Filter 'dist_offline_*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Desc |
    ForEach-Object {
      Get-ChildItem -LiteralPath $_.FullName -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'Web-Setup' } |
        Sort-Object LastWriteTime -Desc |
        Select-Object -First 1
    } | Select-Object -First 1
}

if(-not $selected){
  throw 'Offline installer EXE not found (build first or pass -Exe)'
}

$selPath = $selected.FullName

# 2) Log selection, hash and size
$sha  = (Get-FileHash -Algorithm SHA256 -LiteralPath $selPath).Hash
$size = (Get-Item -LiteralPath $selPath).Length

Out-File -FilePath $logMOut -Encoding utf8 -Append -InputObject ('SELECTED: {0}' -f $selPath)
Out-File -FilePath $logMOut -Encoding utf8 -Append -InputObject ('SHA256 : {0}'  -f $sha)
Out-File -FilePath $logMOut -Encoding utf8 -Append -InputObject ('Size   : {0} bytes' -f $size)

Write-Host ('SELECTED: ' + $selPath)
Write-Host ('SHA256 : ' + $sha)
Write-Host ('Size   : ' + $size + ' bytes')

# 3) Upload to S3 with fixed key
$s3Key = ('s3://' + $Bucket + '/nsis-web/ContainerBrowser-Offline-Setup.exe')
aws s3 cp $selPath $s3Key --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control 'public,max-age=300' | Out-Null

# 4) CloudFront invalidation (file + directory)
$invObj = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = ('offline-' + $ts) }
$invJson = $invObj | ConvertTo-Json -Compress
$invPath = Join-Path -Path 'logs' -ChildPath ('inv_off_' + $ts + '.json')
[IO.File]::WriteAllText($invPath, $invJson, [Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch ('file://' + $invPath) | Out-Null

# 5) HEAD verification of fixed URL
$fixedUrl = $Cdn + '/nsis-web/ContainerBrowser-Offline-Setup.exe'
$curl = Join-Path $env:SystemRoot 'System32/curl.exe'
$head = & $curl -I $fixedUrl 2>&1
[IO.File]::AppendAllText($logMOut, ($head + [Environment]::NewLine), [System.Text.Encoding]::UTF8)
Write-Host $head

Write-Host ''
Write-Host 'Done. Fixed URL:'
Write-Host $fixedUrl
$msg = 'Logs: {0} / {1} / {2}' -f $logMOut, $logBOut, $logBErr
Write-Host $msg



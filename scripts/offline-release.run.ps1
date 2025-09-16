$param(
  [string]$Bucket = 'container-browser-updates',
  [string]$DistributionId = 'E1Q66ASB5AODYF',
  [string]$Cdn = 'https://updates.threadsbooster.jp',
  [switch]$SkipBuild,
  [switch]$ForceBuild,
  [string]$Exe
)

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$tag = "offline_$ts"
$logMain = "logs\$tag.main.out"
$logBuild = "logs\$tag.build.out"
$logBuildErr = "logs\$tag.build.err"

# stop likely lockers (best-effort)
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($n in $procs){ try { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }

# choose exe
if($Exe){
  if(-not (Test-Path $Exe)){ throw "Provided Exe not found: $Exe" }
  $selected = Get-Item -Path $Exe
} else {
  $selected = $null
}

if(-not $selected -and -not $SkipBuild){
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $outDir = "dist_offline_$ts"
  $args = @('electron-builder','--win','nsis','--x64','--publish','never','-c.directories.output=' + $outDir,'-c.nsis.oneClick=true','-c.nsis.perMachine=false','-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe')
  $p = Start-Process -FilePath $npx -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput $logBuild -RedirectStandardError $logBuildErr
  if($p.ExitCode -ne 0){ Write-Host "BUILD failed, see $logBuildErr"; Get-Content $logBuildErr -Tail 200; throw "build failed: $($p.ExitCode)" }
  # find produced exe
  $candidate = Get-ChildItem -Path $outDir -Filter *.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
  if($candidate){ $selected = $candidate }
}

if(-not $selected){
  # fallback: scan recent dist_offline_*
  $candidate = Get-ChildItem -Directory -Filter 'dist_offline_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Desc | ForEach-Object {
    Get-ChildItem $_ -Filter *.exe -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
  } | Select-Object -First 1
  if($candidate){ $selected = $candidate }
}

if(-not $selected){ throw 'offline installer not found; build required or specify -Exe' }

"SELECTED: $($selected.FullName)" | Tee-Object -FilePath $logMain -Append | Out-Host
"SHA256 : $((Get-FileHash $selected.FullName -Algorithm SHA256).Hash)" | Tee-Object -FilePath $logMain -Append | Out-Host
"Size   : $((Get-Item $selected.FullName).Length) bytes" | Tee-Object -FilePath $logMain -Append | Out-Host

# upload
aws s3 cp $selected.FullName "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control "public,max-age=300" | Out-Null

# invalidate
$inv = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = "offline-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_off_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_off_$ts.json | Out-Null

# HEAD check
& "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host
# RANGE check
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host

"`nDONE. URL:`n$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe`nlogs: $logMain / $logBuild / $logBuildErr" | Tee-Object -FilePath $logMain -Append | Out-Host



$Bucket = if($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'container-browser-updates' }
$DistributionId = if($args.Count -ge 2 -and $args[1]) { $args[1] } else { 'E1Q66ASB5AODYF' }
$Cdn = if($args.Count -ge 3 -and $args[2]) { $args[2] } else { 'https://updates.threadsbooster.jp' }

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -ItemType Directory -Force -Path logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$tag = "build_publish_$ts"
$logBuild = "logs\$tag.build.out"
$logBuildErr = "logs\$tag.build.err"
$logMain = "logs\$tag.main.out"

try {
  $pj = Get-Content package.json -Raw | ConvertFrom-Json
  $ver = $pj.version
} catch { $ver = 'unknown' }
Write-Host "Starting build-and-publish (v$ver)" | Tee-Object -FilePath $logMain -Append

# stop processes that may lock files
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($n in $procs){ try { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }

# perform build into timestamped directory
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$out = "dist_offline_$ts"
$args = @(
  'electron-builder',
  '--win','nsis','--x64','--publish','never',
  "--config.directories.output=$out",
  "--config.nsis.oneClick=true",
  "--config.nsis.perMachine=false",
  "--config.nsis.artifactName=ContainerBrowser-Offline-Setup.exe"
)
$p = Start-Process -FilePath $npx -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput $logBuild -RedirectStandardError $logBuildErr
if($p.ExitCode -ne 0){ Write-Host "BUILD failed, see $logBuildErr"; Get-Content $logBuildErr -Tail 200; throw "build failed: $($p.ExitCode)" }

# find produced exe
$exe = Get-ChildItem -Path $out -Filter *.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
if(-not $exe){ throw 'built exe not found' }

"SELECTED: $($exe.FullName)" | Tee-Object -FilePath $logMain -Append | Out-Host
"SHA256 : $((Get-FileHash $exe.FullName -Algorithm SHA256).Hash)" | Tee-Object -FilePath $logMain -Append | Out-Host
"Size   : $((Get-Item $exe.FullName).Length) bytes" | Tee-Object -FilePath $logMain -Append | Out-Host

# upload to S3 as fixed offline name
aws s3 cp $exe.FullName "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control "public,max-age=300" | Out-Null

# invalidate
$inv = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = "buildpub-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_buildpub_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_buildpub_$ts.json | Out-Null

# HEAD and RANGE verification
& "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host

"`nDONE. URL:`n$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe`nlogs: $logMain / $logBuild / $logBuildErr" | Tee-Object -FilePath $logMain -Append | Out-Host



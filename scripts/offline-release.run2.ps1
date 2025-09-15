$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

# positional args fallback (avoid param() to be robust)
$Bucket = if($args.Count -ge 1 -and $args[0]) { $args[0] } else { 'container-browser-updates' }
$DistributionId = if($args.Count -ge 2 -and $args[1]) { $args[1] } else { 'E1Q66ASB5AODYF' }
$Cdn = if($args.Count -ge 3 -and $args[2]) { $args[2] } else { 'https://updates.threadsbooster.jp' }
$SkipBuild = $false

New-Item -ItemType Directory -Force -Path logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$tag = "offline_$ts"
$logMain = "logs\$tag.main.out"
$logBuild = "logs\$tag.build.out"
$logBuildErr = "logs\$tag.build.err"

Write-Host "Bucket=$Bucket DistributionId=$DistributionId CDN=$Cdn" | Tee-Object -FilePath $logMain -Append

# stop likely lockers (best-effort)
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($n in $procs){ try { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }

# prefer existing offline exe from dist_offline_*
$exe = $null
$candidate = Get-ChildItem -Directory -Filter 'dist_offline_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Desc | ForEach-Object {
  Get-ChildItem $_ -File -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
} | Select-Object -First 1
if($candidate){ $exe = $candidate.FullName }

# build if not found
if(-not $exe -and -not $SkipBuild){
  Write-Host 'No existing offline exe found; building...' | Tee-Object -FilePath $logMain -Append
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $outDir = "dist_offline_$ts"
  $args = @('electron-builder','--win','nsis','--x64','--publish','never','-c.directories.output=' + $outDir,'-c.nsis.oneClick=true','-c.nsis.perMachine=false','-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe')
  $p = Start-Process -FilePath $npx -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput $logBuild -RedirectStandardError $logBuildErr
  if($p.ExitCode -ne 0){ Write-Host "BUILD failed, see $logBuildErr"; Get-Content $logBuildErr -Tail 200; throw "build failed: $($p.ExitCode)" }
  $exe = Get-ChildItem -Path $outDir -Filter *.exe -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1 -ExpandProperty FullName
}

if(-not $exe){ throw 'offline installer not found; build required or provide existing exe' }

"SELECTED: $exe" | Tee-Object -FilePath $logMain -Append | Out-Host
"SHA256 : $((Get-FileHash $exe -Algorithm SHA256).Hash)" | Tee-Object -FilePath $logMain -Append | Out-Host
"Size   : $((Get-Item $exe).Length) bytes" | Tee-Object -FilePath $logMain -Append | Out-Host

# upload
aws s3 cp $exe "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control "public,max-age=300" | Out-Null

# invalidate
$inv = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = "offline-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_off_$ts.json",$inv,[Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_off_$ts.json | Out-Null

# HEAD check
& "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host
# RANGE check
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Tee-Object -FilePath $logMain -Append | Out-Host

"`nDONE. URL:`n$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe`nlogs: $logMain / $logBuild / $logBuildErr" | Tee-Object -FilePath $logMain -Append | Out-Host



$param([Parameter(Mandatory=$false)][string]$Bucket = 'container-browser-updates', [string]$DistributionId = 'E1Q66ASB5AODYF', [string]$Cdn = 'https://updates.threadsbooster.jp')

$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ConfirmPreference='None'
$env:AWS_PAGER=''

New-Item -Type Directory -Force logs | Out-Null
$ts = Get-Date -Format yyyyMMdd_HHmmss
$tag = "offline_$ts"
$logB = "logs\$tag.build"
$logM = "logs\$tag.main"

# stop possible locking processes (best-effort)
$procs = @('Container Browser','electron','electron.exe','app-builder','electron-builder','node')
foreach($n in $procs){ try { Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }

# prefer existing offline exe from dist_offline_*
$exe = $null
$found = Get-ChildItem -Directory -Filter 'dist_offline_*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Desc | ForEach-Object {
  Get-ChildItem $_ -File -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1
}
if($found -and $found.Count -gt 0){ $exe = $found[0].FullName }

# build if not found
if(-not $exe){
  $npx = (Get-Command npx.cmd).Source
  $out = "dist_offline_$ts"
  $args = @('electron-builder','--win','nsis','--x64','--publish','never','-c.directories.output=' + $out,'-c.nsis.oneClick=true','-c.nsis.perMachine=false','-c.nsis.artifactName=ContainerBrowser-Offline-Setup.exe')
  $p = Start-Process -FilePath $npx -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$logB.out" -RedirectStandardError "$logB.err"
  if($p.ExitCode -ne 0){ Write-Host "BUILD failed (tail)"; Get-Content "$logB.err" -Tail 200; throw "build failed" }
  $exe = Get-ChildItem "$out\*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Web-Setup' } | Sort-Object LastWriteTime -Desc | Select-Object -First 1 -ExpandProperty FullName
}

if(-not $exe){ throw "offline exe not found" }

"SELECTED: $exe" | Tee-Object -FilePath $logM -Append | Out-Host
"SHA256 : $((Get-FileHash $exe -Algorithm SHA256).Hash)" | Tee-Object -FilePath $logM -Append | Out-Host
"Size   : $((Get-Item $exe).Length) bytes" | Tee-Object -FilePath $logM -Append | Out-Host

# upload to S3
aws s3 cp $exe "s3://$Bucket/nsis-web/ContainerBrowser-Offline-Setup.exe" --no-progress --content-type application/octet-stream --metadata-directive REPLACE --cache-control "public,max-age=300" | Out-Null

# invalidation
$inv = @{ Paths = @{ Quantity = 2; Items = @('/nsis-web/ContainerBrowser-Offline-Setup.exe','/nsis-web/*') }; CallerReference = "offline-$ts" } | ConvertTo-Json -Compress
[IO.File]::WriteAllText("logs\inv_off_$ts.json", $inv, [Text.UTF8Encoding]::new($false))
aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch file://logs/inv_off_$ts.json | Out-Null

# HEAD
& "$env:SystemRoot\System32\curl.exe" -I "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Select-String '^HTTP/' | Tee-Object -FilePath $logM -Append | Out-Host
# RANGE
& "$env:SystemRoot\System32\curl.exe" -A "INetC/1.0" -r 0-1048575 -s -S -o NUL -D - "$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe" | Select-String '^HTTP/' | Tee-Object -FilePath $logM -Append | Out-Host

"`nDONE. URL:`n$Cdn/nsis-web/ContainerBrowser-Offline-Setup.exe`nlogs: $logM / $logB.out / $logB.err" | Out-Host



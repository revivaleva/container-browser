param(
  [string]$Branch = 'ci/s3-root-copy',
  [int]$MaxAttempts = 40,
  [int]$DelaySeconds = 3
)

if(-not (Test-Path -Path logs)) { New-Item -ItemType Directory -Path logs | Out-Null }

$i = 0
$run = $null
while($i -lt $MaxAttempts){
  Start-Sleep -Seconds $DelaySeconds
  $url = "https://api.github.com/repos/revivaleva/container-browser/actions/runs?branch=$Branch"
  $json = C:\Windows\System32\curl.exe -sS $url
  try{ $obj = $json | ConvertFrom-Json } catch { Write-Host 'Failed parse JSON'; $i++; continue }
  if($obj.workflow_runs -and $obj.workflow_runs.Count -gt 0){
    $run = $obj.workflow_runs | Sort-Object created_at -Descending | Select-Object -First 1
    Write-Host "Found run: $($run.id) status=$($run.status) conclusion=$($run.conclusion)"
    if($run.status -eq 'completed'){
      $run | ConvertTo-Json -Depth 6 | Out-File logs\s3root_run.json -Encoding utf8
      Write-Host "Saved run to logs\s3root_run.json"
      break
    }
  } else {
    Write-Host 'No run yet...'
  }
  $i = $i + 1
}

if(-not $run){ Write-Host 'No run found'; exit 2 }
exit 0




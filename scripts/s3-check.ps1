param(
  [string]$Bucket = 'container-browser-updates',
  [string[]]$Keys
)

$ErrorActionPreference = 'Continue'
if(-not (Test-Path -Path logs)) { New-Item -ItemType Directory -Path logs | Out-Null }
$results = @()

foreach($k in $Keys){
  $entry = [ordered]@{ key = $k; exists = $false; detail = $null }
  try{
    $head = aws s3api head-object --bucket $Bucket --key $k 2>&1
    if($LASTEXITCODE -eq 0){
      $entry.exists = $true
      $entry.detail = $head -join "`n"
    } else {
      $entry.exists = $false
      $entry.detail = $head -join "`n"
    }
  } catch {
    $entry.exists = $false
    $entry.detail = $_.Exception.Message
  }
  $results += (New-Object PSObject -Property $entry)
}

$out = @{ bucket = $Bucket; timestamp = (Get-Date).ToString('o'); results = $results }
$out | ConvertTo-Json -Depth 5 | Out-File -FilePath logs/s3-check.json -Encoding utf8

Write-Host "Wrote logs/s3-check.json"
foreach($r in $out.results){ Write-Host ($r.key + ' -> exists=' + $r.exists) }

exit 0




param(
  [string]$DistId = 'E1Q66ASB5AODYF'
)

$ts = (Get-Date -Format 'yyyyMMdd_HHmmss')
$items = @('/latest.yml','/nsis-web/container-browser-0.2.9-x64.nsis.7z','/nsis-web/container-browser-0.2.4-x64.nsis.7z')
$inv = @{ Paths = @{ Quantity = $items.Count; Items = $items }; CallerReference = 'invalidate-' + $ts }
$invJson = $inv | ConvertTo-Json -Depth 5
$invPath = 'inv.json'
$invJson | Out-File -FilePath $invPath -Encoding utf8
Write-Host "Wrote $invPath"

aws cloudfront create-invalidation --distribution-id $DistId --invalidation-batch file://$invPath



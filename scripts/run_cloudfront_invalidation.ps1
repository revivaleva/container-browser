param(
  [string]$DistributionId = 'E1Q66ASB5AODYF'
)

$invObj = @{ Paths = @{ Quantity = 2; Items = @('/latest.yml','/nsis-web/*') }; CallerReference = 'cli-' + (Get-Date -UFormat %s) }
$invJson = $invObj | ConvertTo-Json -Compress
$tmp = Join-Path $env:TEMP 'inv.json'
Set-Content -Path $tmp -Value $invJson -Encoding ascii
Write-Host "Created invalidation payload at: $tmp"
Write-Host $invJson

try {
  $res = aws cloudfront create-invalidation --distribution-id $DistributionId --invalidation-batch "file://$tmp"
  Write-Host "CreateInvalidation response:"
  $res
} catch {
  Write-Host "CloudFront invalidation failed: $($_.Exception.Message)"
  exit 2
} finally {
  Remove-Item -Path $tmp -ErrorAction SilentlyContinue
}



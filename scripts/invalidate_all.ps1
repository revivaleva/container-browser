# CloudFront invalidation script to purge latest assets from root and nsis-web
$ts = (Get-Date).ToString('yyyyMMddHHmmss')
$payloadObj = @{
  Paths = @{ Quantity = 5; Items = @('/latest.yml','/ContainerBrowser-Web-Setup.exe','/container-browser-0.2.4-x64.nsis.7z','/nsis-web/container-browser-0.2.9-x64.nsis.7z','/nsis-web/ContainerBrowser-Web-Setup.exe') }
  CallerReference = "invalidate-$ts"
}
$json = $payloadObj | ConvertTo-Json -Depth 6
$payloadPath = (Join-Path -Path $PSScriptRoot -ChildPath 'invalidation.json')
$json | Out-File -FilePath $payloadPath -Encoding ascii
$payloadPathWin = $payloadPath -replace '\\','/'
aws cloudfront create-invalidation --distribution-id E1Q66ASB5AODYF --invalidation-batch file://$payloadPathWin



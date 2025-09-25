Param()
# apply_cloudfront_root_behaviors.ps1
# 前提: logs/dist_config.json が存在し、aws CLI が設定されていること

$distId = 'E1Q66ASB5AODYF'
$inputPath = 'logs/dist_config.json'
$modifiedPath = 'logs/dist_config_modified.json'
$updateLog = 'logs/cloudfront_update_output.txt'
$invLog = 'logs/cloudfront_invalidation_output.txt'

if (-not (Test-Path $inputPath)) {
    Write-Error "$inputPath not found"
    exit 2
}

try {
    $raw = Get-Content -Raw -Path $inputPath -ErrorAction Stop | ConvertFrom-Json
} catch {
    Write-Error ("failed to read {0}: {1}" -f $inputPath, ($_.Exception.Message -replace "\r|\n"," "))
    exit 2
}

$etag = $raw.ETag.Trim('"')
$dist = $raw.DistributionConfig

if (-not $dist.CacheBehaviors) {
    $dist.CacheBehaviors = @{ Quantity = 0; Items = @() }
}

$items = @()
if ($dist.CacheBehaviors.Items) { $items = $dist.CacheBehaviors.Items }
$originId = $dist.Origins.Items[0].Id
$cachePolicyId = $dist.DefaultCacheBehavior.CachePolicyId

function Add-Behavior([string]$pattern) {
    foreach ($it in $items) {
        if ($it.PathPattern -eq $pattern) {
            Write-Host "pattern exists: $pattern"
            return
        }
    }
    $beh = [PSCustomObject]@{
        PathPattern = $pattern
        TargetOriginId = $originId
        TrustedSigners = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
        TrustedKeyGroups = [PSCustomObject]@{ Enabled = $false; Quantity = 0 }
        ViewerProtocolPolicy = 'redirect-to-https'
        AllowedMethods = [PSCustomObject]@{ Quantity = 2; Items = @('HEAD','GET'); CachedMethods = [PSCustomObject]@{ Quantity = 2; Items = @('HEAD','GET') } }
        SmoothStreaming = $false
        Compress = $true
        LambdaFunctionAssociations = [PSCustomObject]@{ Quantity = 0 }
        FunctionAssociations = [PSCustomObject]@{ Quantity = 0 }
        FieldLevelEncryptionId = ''
        CachePolicyId = $cachePolicyId
        GrpcConfig = [PSCustomObject]@{ Enabled = $false }
    }
    $items += $beh
    Write-Host "added behavior: $pattern"
}

# ルート用のパターン追加
Add-Behavior 'ContainerBrowser-Web-Setup.exe'
Add-Behavior 'Container-Browser-Web-Setup-*.exe'
Add-Behavior '*.nsis.7z'

$dist.CacheBehaviors = @{ Quantity = $items.Count; Items = $items }

# DistributionConfig をファイルに書き出す
$dist | ConvertTo-Json -Depth 50 | Out-File -Encoding utf8 $modifiedPath
Write-Host "WROTE $modifiedPath"

Write-Host "Calling aws cloudfront update-distribution --id $distId --if-match $etag"
aws cloudfront update-distribution --id $distId --distribution-config file://$modifiedPath --if-match $etag | Tee-Object -FilePath $updateLog
if ($LASTEXITCODE -ne 0) {
    Write-Error "update-distribution failed. See $updateLog"
    exit 3
}
Write-Host "update-distribution succeeded (log: $updateLog)"

# invalidation の作成
$paths = @('/ContainerBrowser-Web-Setup.exe','/Container-Browser-Web-Setup-0.3.0.exe','/container-browser-0.3.0-x64.nsis.7z','/latest.yml')
$inv = @{ Paths = @{ Quantity = $paths.Count; Items = $paths }; CallerReference = ('root-behavior-update-' + (Get-Date -UFormat %s)) }
$inv | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 logs/invalidation_batch.json
Write-Host "Created invalidation batch: logs/invalidation_batch.json"

Write-Host "Creating invalidation..."
aws cloudfront create-invalidation --distribution-id $distId --invalidation-batch file://logs/invalidation_batch.json | Tee-Object -FilePath $invLog
if ($LASTEXITCODE -ne 0) {
    Write-Error "create-invalidation failed. See $invLog"
    exit 4
}
Write-Host "Invalidation created (log: $invLog)"

# 簡易アクセス確認（HEAD）
$cdnBase = 'https://updates.threadsbooster.jp'
$results = @()
foreach ($p in $paths) {
    $url = ($cdnBase.TrimEnd('/') + $p)
    Write-Host "HEAD $url"
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -ErrorAction Stop
        $status = $resp.StatusCode
        $len = $resp.Headers['Content-Length']
        $results += @{ url=$url; status=$status; length=$len }
        Write-Host "OK $status length=$len"
    } catch {
        $err = $_.Exception.Message
        Write-Host "ERR $url -> $err"
        $results += @{ url=$url; error=$err }
    }
}
$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 logs/access_check_results.json
Write-Host "WROTE logs/access_check_results.json"



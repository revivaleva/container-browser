<#  post-rotation-finalize.ps1
    Run from repo root (where cf_sign_priv.pem exists).

    EXAMPLE:
    pwsh -File scripts/post-rotation-finalize.ps1 `
      -DistributionId E1Q66ASB5AODYF `
      -KeyGroupId c119acbc-8c6f-4fac-b402-c3df3493ca89 `
      -NewKeyPairId K3OBNT6H3SWSZM `
      -OldKeyPairId K1LGK3C9516OZR `
      -AliasHost updates.threadsbooster.jp `
      -CfDomain d3w2fyzevxqz5r.cloudfront.net `
      -Region ap-northeast-1 `
      -PutToSSM `
      -RemoveOldKey `
      -CommitLog
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$DistributionId,
  [Parameter(Mandatory)] [string]$KeyGroupId,
  [Parameter(Mandatory)] [string]$NewKeyPairId,
  [Parameter()]           [string]$OldKeyPairId,
  [Parameter()]           [string]$AliasHost = "updates.threadsbooster.jp",
  [Parameter(Mandatory)]  [string]$CfDomain,
  [Parameter()]           [string]$Region = "ap-northeast-1",
  [switch]                $PutToSSM,          # /prod/cloudfront/keyPairId & /prod/cloudfront/privateKey へ保存
  [switch]                $RemoveOldKey,      # KeyGroup から旧鍵を削除
  [string]                $SsmPrefix = "/prod/cloudfront",
  [switch]                $CommitLog          # docs へ追記 & git commit
)

$ErrorActionPreference = "Stop"

function Write-Step($msg){ Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Info($msg){ Write-Host "[i] $msg" -ForegroundColor Gray }
function Write-Ok($msg)  { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($m)  { Write-Warning $m }
function Write-Err($m)   { Write-Error $m }

# --- 前提チェック ------------------------------------------------------------
Write-Step "Prerequisites"
if (-not (Test-Path .\cf_sign_priv.pem)) { throw "cf_sign_priv.pem が見つかりません（実行ディレクトリ: $(Get-Location)）。" }

# Node パッケージ確認
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node が見つかりません。Node.js をインストールしてください。" }

# aws-cloudfront-sign の存在チェック（グローバルorローカル）
$signCheck = node -e "try{require('aws-cloudfront-sign');console.log('ok')}catch(e){console.log('ng')}"
if ($signCheck -ne "ok") {
  Write-Warn "aws-cloudfront-sign が見つかりません。プロジェクトに 'npm i aws-cloudfront-sign --save-dev' を実行してください。"
}

# --- 1) 新キーの伝播確認 ------------------------------------------------------
Write-Step "Wait until distribution reports NewKeyPairId=$NewKeyPairId active"
$timeoutSec = 600; $interval = 20; $elapsed = 0; $seen = $false
while ($elapsed -le $timeoutSec) {
  $active = aws --output json cloudfront get-distribution --id $DistributionId `
    --query "Distribution.ActiveTrustedKeyGroups.Items[].KeyPairIds.Items" 2>$null | ConvertFrom-Json
  if ($active -and ($active | Select-String -SimpleMatch $NewKeyPairId)) { $seen = $true; break }
  Write-Info "still propagating... ($elapsed/$timeoutSec sec)"
  Start-Sleep -Seconds $interval
  $elapsed += $interval
}
if (-not $seen) { Write-Warn "ActiveTrustedKeyGroups に新キーが現れませんでした。続行しますが 403 になる可能性があります。" }
else { Write-Ok "NewKeyPairId ($NewKeyPairId) が Active に反映済み。" }

# --- 2) 署名URLテスト（CF直・Alias） ----------------------------------------
function New-SignedUrl([string]$targetUrl){
  $script = @"
const fs=require('fs');
const {getSignedUrl}=require('aws-cloudfront-sign');
const id=process.env.KP, key=fs.readFileSync('cf_sign_priv.pem','utf8');
const url=process.env.URL, t=Date.now()+10*60*1000;
console.log(getSignedUrl(url,{keypairId:id,privateKeyString:key,expireTime:t}));
"@
  $env:KP = $NewKeyPairId; $env:URL = $targetUrl
  node -e $script
}

function Test-Url([string]$url){
  $head = (curl.exe -I "$url" 2>$null) -join "`n"
  ($head -split "`n")[0]
}

Write-Step "Test signed/unsigned against CF domain"
$cfUrl   = "https://$CfDomain/latest.yml"
$cfSig   = New-SignedUrl $cfUrl
Write-Info "Unsigned(CF): $(Test-Url $cfUrl)"
Write-Info "Signed  (CF): $(Test-Url $cfSig)"

Write-Step "Test signed/unsigned against Alias host"
$aliasUrl = "https://$AliasHost/latest.yml"
$aliasSig = New-SignedUrl $aliasUrl
Write-Info "Unsigned(Alias): $(Test-Url $aliasUrl)"
Write-Info "Signed  (Alias): $(Test-Url $aliasSig)"

# --- 3) 旧鍵の撤去（任意） ----------------------------------------------------
if ($RemoveOldKey -and $OldKeyPairId) {
  Write-Step "Remove old key from Key Group ($OldKeyPairId)"
  $etag = aws --output text cloudfront get-key-group-config --id $KeyGroupId --query ETag
  $cfg  = aws --output json cloudfront get-key-group-config --id $KeyGroupId | ConvertFrom-Json
  $before = @($cfg.KeyGroupConfig.Items)
  $cfg.KeyGroupConfig.Items = @($cfg.KeyGroupConfig.Items | Where-Object { $_ -ne $OldKeyPairId })
  if ($before.Count -eq $cfg.KeyGroupConfig.Items.Count) {
    Write-Info "旧鍵 $OldKeyPairId は既に含まれていません。"
  } else {
    ($cfg.KeyGroupConfig | ConvertTo-Json -Compress) | Set-Content kg.updated.json
    aws cloudfront update-key-group --id $KeyGroupId --if-match $etag --key-group-config file://kg.updated.json | Out-Null
    Write-Ok "Key Group から旧鍵を除去しました。"
  }
}

# --- 4) SSM Parameter Store へ保存（任意） ------------------------------------
if ($PutToSSM) {
  Write-Step "Put parameters to SSM ($SsmPrefix)"
  try {
    aws ssm put-parameter --region $Region --name "$SsmPrefix/keyPairId" --type String --overwrite --value $NewKeyPairId | Out-Null
    aws ssm put-parameter --region $Region --name "$SsmPrefix/privateKey" --type SecureString --overwrite --value fileb://cf_sign_priv.pem | Out-Null
    Write-Ok "SSM へ keyPairId / privateKey を保存しました。"
  } catch {
    Write-Warn "SSM への保存に失敗: $($_.Exception.Message)"
    Write-Info "必要権限例: ssm:PutParameter/GetParameter/DeleteParameter (Resource: arn:aws:ssm:$Region:<acct>:parameter$SsmPrefix/*)"
  }
}

# --- 5) DNS 簡易診断 ----------------------------------------------------------
Write-Step "DNS check"
try {
  $a1 = Resolve-DnsName $AliasHost -Server 1.1.1.1 -ErrorAction Stop
  $a8 = Resolve-DnsName $AliasHost -Server 8.8.8.8 -ErrorAction Stop
  Write-Ok "Public DNS resolves (1.1.1.1 / 8.8.8.8)"
} catch { Write-Warn "Public DNS lookup failed: $($_.Exception.Message)" }

# --- 6) docs へ追記 & commit（任意） ------------------------------------------
if ($CommitLog) {
  Write-Step "Append run log and commit"
  $log = @"
### $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
- Dist: $DistributionId
- KG  : $KeyGroupId
- New : $NewKeyPairId
- Old : ${OldKeyPairId}
- CF  : $(Test-Url $cfUrl) / $(Test-Url $cfSig)
- ALIAS: $(Test-Url $aliasUrl) / $(Test-Url $aliasSig)
"@
  $doc = "docs/cf-rotation-check.md"
  if (-not (Test-Path $doc)) { New-Item -ItemType File -Path $doc -Force | Out-Null }
  Add-Content -Path $doc -Value $log
  git add $doc 2>$null
  git commit -m "chore(cf): post-rotation finalize log ($NewKeyPairId)" 2>$null
  Write-Ok "Log appended to $doc and committed."
}

Write-Ok "All done."

(（任意）ロールバック用：scripts/cf-rollback-oldkey.ps1）

# End



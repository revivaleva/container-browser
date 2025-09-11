# CloudFront signed URL generator (custom policy)
# Usage example:
#   .\generate_cf_signed_url.ps1 -Url "https://d3w2fyzevxqz5r.cloudfront.net/Container%20Browser%20Web%20Setup%200.2.0.exe" -PrivateKeyPath "C:\keys\cf_sign_private.pem" -KeyId "PUBKEY-ID-HERE" -ExpireMinutes 60

param(
    [Parameter(Mandatory=$true)]
    [string]$Url,

    [Parameter(Mandatory=$true)]
    [string]$PrivateKeyPath,

    [Parameter(Mandatory=$true)]
    [string]$KeyId,

    [int]$ExpireMinutes = 60
)

function Write-ErrorAndExit([string]$msg) {
    Write-Error $msg
    exit 1
}

# Check OpenSSL availability
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue)
if (-not $openssl) {
    Write-ErrorAndExit "OpenSSL not found in PATH. Please install OpenSSL or ensure it's available as 'openssl' in PATH."
}

# Validate private key file
if (-not (Test-Path -Path $PrivateKeyPath -PathType Leaf)) {
    Write-ErrorAndExit "Private key file not found: $PrivateKeyPath"
}

# Calculate expiry epoch (seconds since 1970-01-01T00:00:00Z)
$epochBase = Get-Date -Date "1970-01-01T00:00:00Z"
$expireTime = (Get-Date).ToUniversalTime().AddMinutes($ExpireMinutes)
$expiryEpoch = [int]([Math]::Floor(($expireTime - $epochBase).TotalSeconds))

# Build custom policy JSON (CloudFront custom policy)
$policyObj = [pscustomobject]@{
    Statement = @([
        [pscustomobject]@{
            Resource = $Url
            Condition = [pscustomobject]@{
                DateLessThan = [pscustomobject]@{
                    'AWS:EpochTime' = $expiryEpoch
                }
            }
        }
    ])
}

$policyJson = ($policyObj | ConvertTo-Json -Depth 10)

# Temporary file paths
$tmpDir = Join-Path -Path $env:TEMP -ChildPath ("cfsign_" + ([System.Guid]::NewGuid().ToString()))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
$policyFile = Join-Path $tmpDir "policy.json"
$sigFile = Join-Path $tmpDir "sig.bin"

try {
    # Write policy JSON
    Set-Content -Path $policyFile -Value $policyJson -Encoding UTF8

    # Sign the policy using OpenSSL (SHA1 with RSA: CloudFront expects RSA-SHA1 signature)
    # Note: If your CloudFront setup requires a different signature algorithm, adjust accordingly.
    & openssl dgst -sha1 -sign $PrivateKeyPath -out $sigFile $policyFile
    if ($LASTEXITCODE -ne 0) {
        Write-ErrorAndExit "OpenSSL signing failed (exit $LASTEXITCODE)."
    }

    # Base64 encode signature and policy
    $sigBytes = [System.IO.File]::ReadAllBytes($sigFile)
    $sigB64 = [System.Convert]::ToBase64String($sigBytes)
    $policyB64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($policyJson))

    # Make URL-safe (replace +/ with -_ and trim =)
    function To-UrlSafeBase64([string]$b64) {
        return ($b64.TrimEnd('=') -replace '\+', '-' -replace '/', '_')
    }

    $sigSafe = To-UrlSafeBase64 $sigB64
    $policySafe = To-UrlSafeBase64 $policyB64

    # Build signed URL (attach Policy, Signature, Key-Pair-Id)
    $sep = if ($Url -match '\?') { '&' } else { '?' }
    $signedUrl = "${Url}${sep}Policy=${policySafe}&Signature=${sigSafe}&Key-Pair-Id=${KeyId}"

    Write-Output "# Signed URL (expires: $expireTime UTC / epoch: $expiryEpoch)"
    Write-Output $signedUrl

} finally {
    # Cleanup tmp files
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}

# End of script

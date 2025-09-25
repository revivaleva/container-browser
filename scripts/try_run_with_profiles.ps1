Param()
# Try default AWS credentials, then try each profile from `aws configure list-profiles`.
Write-Host 'Starting credential check and script run'

function Try-Default {
    Write-Host 'Trying default credentials...'
    Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue
    aws sts get-caller-identity --output json > logs/aws_identity_default.json 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'Default credentials OK'
        Get-Content logs/aws_identity_default.json -Raw | Out-File -Encoding utf8 logs/aws_identity.json
        & .\scripts\apply_cloudfront_root_behaviors.ps1 | Tee-Object -FilePath logs/apply_cloudfront_run_final.txt
        exit $LASTEXITCODE
    } else {
        Write-Host 'Default credentials failed'
        return 1
    }
}

function Try-Profiles {
    Write-Host 'Listing profiles...'
    $raw = aws configure list-profiles 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
        Write-Host 'No profiles available or aws CLI error'
        return 1
    }
    $profiles = $raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    foreach ($p in $profiles) {
        Write-Host "Trying profile: $p"
        $env:AWS_PROFILE = $p
        aws sts get-caller-identity --output json > logs/aws_identity_profile.json 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Profile $p OK"
            Get-Content logs/aws_identity_profile.json -Raw | Out-File -Encoding utf8 logs/aws_identity.json
            & .\scripts\apply_cloudfront_root_behaviors.ps1 | Tee-Object -FilePath logs/apply_cloudfront_run_final.txt
            exit $LASTEXITCODE
        } else {
            Write-Host "Profile $p failed"
        }
    }
    return 1
}

Try-Default
if ($LASTEXITCODE -eq 0) { exit 0 }
Try-Profiles
if ($LASTEXITCODE -eq 0) { exit 0 }

Write-Host 'All attempts failed'
exit 2



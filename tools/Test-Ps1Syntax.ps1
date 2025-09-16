param(
  [Parameter(Mandatory)][string[]]$Path
)
${ErrorActionPreference} = 'Stop'

New-Item -ItemType Directory -Force logs | Out-Null
$ts  = Get-Date -Format yyyyMMdd_HHmmss
$log = "logs\ps1_syntax_$ts.out"

# 正規化: カンマ区切り文字列/配列の両方を許容
$expanded = @()
foreach($item in $Path){
  if($null -ne $item -and $item -match ','){
    $expanded += ($item -split '\s*,\s*') | Where-Object { $_ -ne '' }
  } else {
    $expanded += $item
  }
}

$allOk = $true
foreach($pp in $expanded){
  if(-not (Test-Path $pp)){
    ("not found: {0}" -f $pp) | Tee-Object -FilePath $log -Append | Out-Host
    $allOk = $false
    continue
  }

  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($pp, [ref]$tokens, [ref]$errors)
  if($errors -and $errors.Count -gt 0){
    foreach($err in $errors){
      $loc = $err.Extent.StartLineNumber.ToString() + ':' + $err.Extent.StartColumnNumber.ToString()
      ('{0}:{1}  {2}' -f $pp, $loc, $err.Message) | Tee-Object -FilePath $log -Append | Out-Host
    }
    $allOk = $false
  } else {
    ("No syntax errors in {0}" -f $pp) | Tee-Object -FilePath $log -Append | Out-Host
  }
}

if(-not $allOk){ exit 1 } else { exit 0 }



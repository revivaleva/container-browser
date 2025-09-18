param(
  [string]$Owner = 'revivaleva',
  [string]$Repo  = 'container-browser'
)

try {
  $token = (Get-Content -Raw 'scripts/.github_token').Trim()
} catch {
  Write-Error 'Failed to read scripts/.github_token'; exit 1
}

function Invoke-GHGet([string]$uri){
  try { return Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop } 
  catch { Write-Error "GET failed: $uri -> $($_.Exception.Message)"; return $null }
}

function Invoke-GHDelete([string]$uri){
  try { Invoke-RestMethod -Method Delete -Uri $uri -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' } -ErrorAction Stop; return $true } 
  catch { Write-Error "DELETE failed: $uri -> $($_.Exception.Message)"; return $false }
}

Write-Output "1) Checking repository secrets"
$repoSecrets = Invoke-GHGet "https://api.github.com/repos/$Owner/$Repo/actions/secrets"
if ($repoSecrets -and $repoSecrets.secrets) {
  $names = $repoSecrets.secrets | ForEach-Object { $_.name }
  $names | ForEach-Object { Write-Output " - $_" }
} else { Write-Output ' No repository secrets or unable to list.' }

Write-Output "\n2) Checking repository variables"
$vars = Invoke-GHGet "https://api.github.com/repos/$Owner/$Repo/actions/variables"
if ($vars -and $vars.variables) { $vars.variables | ForEach-Object { Write-Output " - $($_.name)" } } else { Write-Output ' No repository variables or unable to list.' }

Write-Output "\n3) Checking environment secrets (per environment)"
$envs = Invoke-GHGet "https://api.github.com/repos/$Owner/$Repo/environments"
if ($envs -and $envs.environments) {
  foreach($e in $envs.environments){
    $ename = $e.name
    Write-Output "Environment: $ename"
    $es = Invoke-GHGet "https://api.github.com/repos/$Owner/$Repo/environments/$ename/secrets"
    if ($es -and $es.secrets) { $es.secrets | ForEach-Object { Write-Output " - $($_.name)" } } else { Write-Output '  (no secrets or unable to list)'}
  }
} else { Write-Output ' No environments or unable to list.' }

Write-Output "\n4) Checking organization-level secrets (if applicable)"
$orgSecrets = Invoke-GHGet "https://api.github.com/orgs/$Owner/actions/secrets"
if ($orgSecrets -and $orgSecrets.secrets) { $orgSecrets.secrets | ForEach-Object { Write-Output " - $($_.name)" } } else { Write-Output ' No org-level secrets or unable to list (403 possible).' }

Write-Output "\n5) Deleting any CSC_LINK / WIN_CSC_LINK matches in repo/env/org"
$pattern = '(?i)^(WIN_)?CSC_LINK$'

# Repo secrets
if ($repoSecrets -and $repoSecrets.secrets){
  foreach($s in $repoSecrets.secrets){ if ($s.name -match $pattern){ Write-Output "Deleting repo secret $($s.name)"; Invoke-GHDelete "https://api.github.com/repos/$Owner/$Repo/actions/secrets/$($s.name)" } }
}

# Repo variables
if ($vars -and $vars.variables){
  foreach($v in $vars.variables){ if ($v.name -match $pattern){ Write-Output "Deleting repo variable $($v.name)"; Invoke-GHDelete "https://api.github.com/repos/$Owner/$Repo/actions/variables/$($v.name)" } }
}

# Environment secrets
if ($envs -and $envs.environments){
  foreach($e in $envs.environments){
    $ename = $e.name
    $es = Invoke-GHGet "https://api.github.com/repos/$Owner/$Repo/environments/$ename/secrets"
    if ($es -and $es.secrets){
      foreach($s in $es.secrets){ if ($s.name -match $pattern){ Write-Output "Deleting env secret $($s.name) in $ename"; Invoke-GHDelete "https://api.github.com/repos/$Owner/$Repo/environments/$ename/secrets/$($s.name)" } }
    }
  }
}

# Org secrets
if ($orgSecrets -and $orgSecrets.secrets){
  foreach($s in $orgSecrets.secrets){ if ($s.name -match $pattern){ Write-Output "Deleting org secret $($s.name)"; Invoke-GHDelete "https://api.github.com/orgs/$Owner/actions/secrets/$($s.name)" } }
}

Write-Output 'All checks and deletions attempted.'


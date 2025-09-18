param([string]$Token)
if(-not $Token){ Write-Error 'Token required'; exit 1 }
$owner='revivaleva'; $repo='container-browser'
$headers=@{ Authorization = 'token ' + $Token; Accept='application/vnd.github+json' }
$resp = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$owner/$repo/actions/runs?per_page=50"
$resp.workflow_runs | Where-Object { $_.name -like '*Build & Publish*' } | Select-Object id,name,status,conclusion,created_at | Sort-Object created_at -Descending | Format-Table -AutoSize



param()

$ErrorActionPreference='Stop'
function W($m){ Write-Host $m -ForegroundColor Cyan }

# 1) 競合の確認
W "Check conflicts..."
$conf = git diff --name-only --diff-filter=U
if ($conf.Count -gt 0 -and ($conf -ne '.gitignore' -and $conf -notcontains '.gitignore')) {
  Write-Error "'.gitignore' 以外にも競合があります: `n$($conf -join "`n")"
  exit 1
}

# 2) .gitignore を安全な内容で置換
if ($conf -contains '.gitignore' -or $conf -eq '.gitignore') {
  W "Rewrite .gitignore"
@"
# Build / dependencies
node_modules/
dist/
out/
build/
*.log

# Framework caches
.cache/
.next/
%TEMP%/

# Local profiles
profiles/

# OS
.DS_Store

# Local tools (do not commit)
tools/bfg*.jar

# Secrets / env
.env
.env.*

# IDE / local configs
.cursor/
"@ | Set-Content -Encoding utf8 .gitignore
  git add .gitignore
}

# 3) 追跡NGファイルをローカル除外に追加
W "Harden local excludes"
$ex = @(
  "tools/bfg*.jar",
  ".cursor/",
  "cf_sign_priv.pem",
  "cf_sign_pub.pem",
  "cf_create_publickey_output.json"
)
$ex | ForEach-Object { if (-not (Select-String -Quiet -Path .git/info/exclude -Pattern ([regex]::Escape($_)) -ErrorAction SilentlyContinue)) {
    Add-Content -Path .git/info/exclude -Value $_
}}

# 4) cherry-pick 続行 or コミット
W "Continue cherry-pick/commit"
$head = Test-Path .git\CHERRY_PICK_HEAD
if ($head) {
  git cherry-pick --continue 2>$null | Out-Null
} else {
  if ((git status --porcelain).Trim().Length -gt 0) {
    git commit -m "chore: resolve .gitignore conflict and finish cherry-pick"
  }
}

# 念のため JAR が追跡されていないか検査
if (git ls-files tools/bfg*.jar) { Write-Error "tools/bfg*.jar が追跡状態です。rm --cached で外してください"; exit 1 }

# 5) push & PR 比較URL
W "Push branch"
$branch = "feat/web-installer-switch-v2"
git push -u origin $branch

W "Generate compare URL"
$remote = (git remote get-url origin).Trim()
if ($remote -match '^git@github\.com:(.+?)/(.+?)(\.git)?$') { $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
elseif ($remote -match '^https?://github\.com/(.+?)/(.+?)(\.git)?$') { $repo = "https://github.com/$($Matches[1])/$($Matches[2].TrimEnd('.git'))" }
else { throw "Unsupported remote: $remote" }

$compare = "$repo/compare/main...$branch?expand=1"
Write-Host "`nOpen this URL to create PR:" -ForegroundColor Yellow
Write-Host $compare -ForegroundColor Yellow

# Windows ならブラウザで開く
if ($env:OS -like "*Windows*") { Start-Process $compare }
W "DONE"



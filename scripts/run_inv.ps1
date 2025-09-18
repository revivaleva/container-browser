param()
${ts} = (Get-Date -Format 'yyyyMMdd_HHmmss')
${inv} = @"
{"Paths":{"Quantity":3,"Items":["/latest.yml","/nsis-web/container-browser-0.2.9-x64.nsis.7z","/nsis-web/container-browser-0.2.4-x64.nsis.7z"]},"CallerReference":"invalidate-${ts}"}
"@
${invPath} = 'inv.json'
${inv} | Out-File -FilePath ${invPath} -Encoding utf8
aws cloudfront create-invalidation --distribution-id 'E1Q66ASB5AODYF' --invalidation-batch file://${invPath}



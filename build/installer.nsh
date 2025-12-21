!macro preInstall
  ; Attempt graceful close using PowerShell to invoke CloseMainWindow
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { $_.CloseMainWindow() } catch {} }"'
  Sleep 1000
  ; Wait a bit for process to exit politely
  nsExec::ExecToLog 'powershell -NoProfile -Command "Start-Sleep -Seconds 1"'
  ; Attempt polite Stop-Process
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue } catch {} }"'
  Sleep 500
  ; Final fallback: taskkill strongly
  nsExec::ExecToLog 'taskkill /IM "Container Browser.exe" /T /F >NUL 2>&1'
!macroend


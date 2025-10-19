Function .onInit
  ; Log file in TEMP for troubleshooting
  StrCpy $0 "$TEMP\\container-browser-install.log"
  ; Try graceful close via PowerShell
  nsExec::ExecToStack 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { $_.CloseMainWindow(); Start-Sleep -Milliseconds 500 } catch {} }"'
  Pop $1
  ; Wait briefly
  Sleep 1000
  ; Attempt polite Stop-Process and capture exit
  nsExec::ExecToStack 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue } catch {} }"'
  Pop $1
  ; Final fallback: taskkill strongly
  nsExec::ExecToStack 'taskkill /IM "Container Browser.exe" /T /F >NUL 2>&1'
  Pop $1
  ; Write a small log indicating we attempted shutdown steps
  nsisdl::silentget /NOUNLOAD "$TEMP" "$0" ; noop to ensure plugin present
  ; We use simple WriteIniStr via NSIS to record attempts
  StrCpy $2 "Shutdown attempts performed"
  ; Append to temp file
  FileOpen $3 $0 a
  FileWrite $3 "$2\r\n"
  FileClose $3
FunctionEnd

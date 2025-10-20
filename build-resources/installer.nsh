Function .onInit
  ; Log file in TEMP for troubleshooting
  StrCpy $0 "$TEMP\\container-browser-install.log"
  ; Attempt graceful close via CloseMainWindow
  nsExec::ExecToStack 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { $_.CloseMainWindow(); Start-Sleep -Milliseconds 500 } catch {} }"'
  Pop $1
  ; Wait briefly for processes to exit
  Sleep 1000
  ; Attempt polite Stop-Process (no force)
  nsExec::ExecToStack 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"Container Browser*\" -or $_.Name -like \"Container Browser*\" } | ForEach-Object { try { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue } catch {} }"'
  Pop $1
  ; Write a small log indicating attempts
  FileOpen $3 $0 a
  FileWrite $3 "Graceful shutdown attempts executed (no forced kill)\r\n"
  FileClose $3
FunctionEnd

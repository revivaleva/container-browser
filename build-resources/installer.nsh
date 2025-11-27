Function .onInit
  ; Log file in TEMP for troubleshooting
  StrCpy $0 "$TEMP\\container-browser-install.log"
  
  ; Enhanced graceful shutdown process
  FileOpen $3 $0 a
  FileWrite $3 "Starting Container Browser shutdown process...$\r$\n"
  
  ; Step 1: Attempt graceful close via CloseMainWindow (multiple attempts)
  FileWrite $3 "Step 1: Attempting graceful window close...$\r$\n"
  nsExec::ExecToStack 'powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"*Container Browser*\" -or $_.Name -like \"*Container Browser*\" -or $_.ProcessName -eq \"electron\" } | ForEach-Object { try { $_.CloseMainWindow(); Start-Sleep -Milliseconds 200 } catch {} }"'
  Pop $1
  Sleep 1500
  
  ; Step 2: Check if processes still exist and try polite termination
  FileWrite $3 "Step 2: Checking remaining processes...$\r$\n"
  nsExec::ExecToStack 'powershell -NoProfile -Command "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"*Container Browser*\" -or $_.Name -like \"*Container Browser*\" -or $_.ProcessName -eq \"electron\" }; if ($procs) { $procs | ForEach-Object { try { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue } catch {} } }"'
  Pop $1
  Sleep 1000
  
  ; Step 3: Final check and wait
  FileWrite $3 "Step 3: Final verification...$\r$\n"
  nsExec::ExecToStack 'powershell -NoProfile -Command "$remaining = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like \"*Container Browser*\" -or $_.Name -like \"*Container Browser*\" }; if ($remaining) { Write-Host \"Warning: $($remaining.Count) processes still running\" } else { Write-Host \"All processes terminated successfully\" }"'
  Pop $1
  
  FileWrite $3 "Graceful shutdown process completed.$\r$\n"
  FileClose $3
FunctionEnd

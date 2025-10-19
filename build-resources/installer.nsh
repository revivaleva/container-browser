Function .onInit
  ; Immediate forced termination of running app processes (no user warning)
  StrCpy $0 "$TEMP\\container-browser-install.log"
  ; Force kill by executable name
  nsExec::ExecToStack 'taskkill /IM "Container Browser.exe" /T /F >NUL 2>&1'
  Pop $1
  ; Also attempt to kill any child electron processes by process name
  nsExec::ExecToStack 'taskkill /IM "electron.exe" /T /F >NUL 2>&1'
  Pop $1
  ; Log that we issued force kill commands
  FileOpen $3 $0 a
  FileWrite $3 "Forced kill executed on Container Browser and electron processes\r\n"
  FileClose $3
FunctionEnd

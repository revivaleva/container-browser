@echo off
setlocal

:: ensure logs dir
if not exist "%~dp0\..\logs" mkdir "%~dp0\..\logs"
set DEBUG=electron-builder

:: run electron-builder and capture exit code
npx electron-builder --win --x64 --publish never > "%~dp0\..\logs\electron_debug2.out" 2> "%~dp0\..\logs\electron_debug2.err"
necho EXIT=%ERRORLEVEL% > "%~dp0\..\logs\electron_debug2.exit"
endlocal
exit /b %ERRORLEVEL%

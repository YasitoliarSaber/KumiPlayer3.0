@echo off
chcp 65001 >nul
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tmdb-image-hosts.ps1" -Restore
set "TMDB_REPAIR_EXIT=%errorlevel%"
if not "%TMDB_REPAIR_EXIT%"=="0" pause
exit /b %TMDB_REPAIR_EXIT%

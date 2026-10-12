@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
set "KUMIPLAYER_INSTALLER_LOCAL_TEST=-LocalTest"
if /I "%~1"=="--public-release" set "KUMIPLAYER_INSTALLER_LOCAL_TEST="
if defined KUMIPLAYER_INSTALLER_LOCAL_TEST echo LOCAL TEST ONLY: this installer has not completed public release review.

echo ============================================
echo KumiPlayer complete Windows installer build
echo ============================================
echo This build never copies the project data directory.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\ensure_kumiplayer_runtime_stopped.ps1"
if errorlevel 1 goto :failed

echo Checking this computer before building...
if exist "backend\.venv\Scripts\activate.bat" call "backend\.venv\Scripts\activate.bat"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\check_installer_prerequisites.ps1" %KUMIPLAYER_INSTALLER_LOCAL_TEST%
if errorlevel 1 goto :failed

echo [1/9] Building the self-contained Python backend...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build_backend_sidecar.ps1"
if errorlevel 1 goto :failed
if not exist "packaging\runtime\backend\KumiPlayerBackend.exe" (
    echo [ERROR] KumiPlayerBackend.exe was not generated.
    goto :failed
)

echo [2/9] Staging KumiPlayer built-in MPV runtime and portable configuration...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stage_mpv_runtime.ps1" %KUMIPLAYER_INSTALLER_LOCAL_TEST%
if errorlevel 1 goto :failed

echo [3/9] Checking frontend dependencies...
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 (
    echo Frontend dependencies are incomplete. Restoring them from package-lock.json...
    call npm ci
    if errorlevel 1 goto :failed
)

echo [4/9] Running TypeScript checks...
call npx tsc --noEmit
if errorlevel 1 goto :failed

echo [5/9] Building the desktop shell and its native loader...
cargo build --release --manifest-path "src-tauri\Cargo.toml"
if errorlevel 1 goto :failed
if not exist "src-tauri\target\release\WebView2Loader.dll" (
    echo [ERROR] Rust did not generate WebView2Loader.dll.
    goto :failed
)

echo [6/9] Staging the native WebView2 loader for NSIS...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stage_tauri_runtime.ps1"
if errorlevel 1 goto :failed

echo [7/9] Building the NSIS installer...
call npm run tauri build -- --config src-tauri\tauri.installer.conf.json --bundles nsis
if errorlevel 1 goto :failed

echo [8/9] Verifying installer contents...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\verify_installer_bundle.ps1" %KUMIPLAYER_INSTALLER_LOCAL_TEST%
if errorlevel 1 goto :failed

echo [9/9] Publishing release\KumiPlayer-Setup.exe...
if not exist "release\.staging" mkdir "release\.staging"
for %%F in ("src-tauri\target\release\bundle\nsis\*setup.exe") do copy /y "%%~fF" "release\.staging\KumiPlayer-Setup.exe" >nul
if not exist "release\.staging\KumiPlayer-Setup.exe" (
    echo [ERROR] The NSIS installer was not generated.
    goto :failed
)
move /y "release\.staging\KumiPlayer-Setup.exe" "release\KumiPlayer-Setup.exe" >nul
if errorlevel 1 (
    echo [ERROR] Could not replace release\KumiPlayer-Setup.exe.
    goto :failed
)

echo Complete installer published as release\KumiPlayer-Setup.exe
echo End users do not need Python, Node.js, or Rust. KumiPlayer includes its managed MPV runtime and portable configuration.
endlocal
exit /b 0

:failed
echo.
echo [ERROR] Installer build stopped. Review the messages above.
echo 构建已停止，请查看上方的缺项或错误。构建安装包需要开发环境；普通用户只需运行安装包。
if /I not "%KUMIPLAYER_BUILD_NO_PAUSE%"=="1" pause
endlocal
exit /b 1

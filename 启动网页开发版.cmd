@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title KumiPlayer 网页开发版
where node >nul 2>nul
if errorlevel 1 (
    echo 未找到 Node.js，请先安装项目使用的 Node.js，然后重试。
    if not "%KUMIPLAYER_WEB_DEV_NO_OPEN%"=="1" pause
    exit /b 1
)
node "%~dp0scripts\desktop\start-web-dev.cjs"
if errorlevel 1 (
    echo.
    echo 网页开发版未能启动，请查看上面的提示。
    if not "%KUMIPLAYER_WEB_DEV_NO_OPEN%"=="1" pause
    exit /b 1
)
endlocal

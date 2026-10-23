@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Music Fleet v8 - Start
cd /d "%~dp0"
set "MUSIC_RUN_NODE=node"
if defined MUSIC_NODE_EXECUTABLE set "MUSIC_RUN_NODE=%MUSIC_NODE_EXECUTABLE%"
"%MUSIC_RUN_NODE%" -e "require('./utils/nodeRuntime').assertSupportedRuntime(); console.log('Node.js: '+process.version)"
if errorlevel 1 goto :fail
if not defined MUSIC_PERF_PROFILE set "MUSIC_PERF_PROFILE=auto-high-performance"
if not defined NODE_HEAP_MB for /f "delims=" %%H in ('"%MUSIC_RUN_NODE%" -e "process.stdout.write(String(Number(require('./config').PERFORMANCE_NODE_HEAP_MB)||0))"') do set "NODE_HEAP_MB=%%H"
if not defined NODE_HEAP_MB set "NODE_HEAP_MB=0"
if not exist node_modules (
  echo Run install.bat first. Node.js 22.16.0 or newer is required.
  pause
  exit /b 1
)
"%MUSIC_RUN_NODE%" scripts/dependency-preflight.js
if errorlevel 1 goto :fail
"%MUSIC_RUN_NODE%" scripts/fleet-check.js
if errorlevel 1 goto :fail
echo Music Fleet v8 - one process for every configured bot.
echo Press Ctrl+C to stop.
:run
if "%NODE_HEAP_MB%"=="0" (
  "%MUSIC_RUN_NODE%" index.js
) else (
  "%MUSIC_RUN_NODE%" --max-old-space-size=%NODE_HEAP_MB% index.js
)
if not errorlevel 1 exit /b 0
echo Process failed. Restarting in 5 seconds. Press Ctrl+C to stop.
timeout /t 5 /nobreak >nul
goto :run
:fail
echo Fix the configuration or dependency error above before starting.
pause
exit /b 1

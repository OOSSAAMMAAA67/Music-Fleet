@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
set "MUSIC_RUN_NODE=node"
if defined MUSIC_NODE_EXECUTABLE set "MUSIC_RUN_NODE=%MUSIC_NODE_EXECUTABLE%"
"%MUSIC_RUN_NODE%" -e "require('./utils/nodeRuntime').assertSupportedRuntime(); console.log('Node.js: '+process.version)"
if errorlevel 1 goto :fail
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run check:config
if errorlevel 1 goto :fail
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run diagnose
if errorlevel 1 goto :fail
"%MUSIC_RUN_NODE%" scripts/pm2-preflight.js
if errorlevel 1 goto :fail
:finish
pause
exit /b 0
:fail
echo Diagnostics failed. Fix the preceding error before starting.
pause
exit /b 1

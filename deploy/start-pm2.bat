@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "MUSIC_RUN_NODE=node"
if defined MUSIC_NODE_EXECUTABLE set "MUSIC_RUN_NODE=%MUSIC_NODE_EXECUTABLE%"
"%MUSIC_RUN_NODE%" scripts/pm2-control.js start
exit /b %errorlevel%

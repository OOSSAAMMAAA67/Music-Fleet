@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Music Fleet v8 - Install
cd /d "%~dp0"
set "MUSIC_RUN_NODE=node"
if defined MUSIC_NODE_EXECUTABLE set "MUSIC_RUN_NODE=%MUSIC_NODE_EXECUTABLE%"
"%MUSIC_RUN_NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo Install 64-bit Node.js 22.16.0 or newer, then run this file again.
  pause
  exit /b 1
)
"%MUSIC_RUN_NODE%" -e "require('./utils/nodeRuntime').assertSupportedRuntime(); console.log('Node.js: '+process.version)"
if errorlevel 1 goto :fail
echo [preflight] Verifying installer commands before downloading dependencies...
"%MUSIC_RUN_NODE%" -e "const p=require('./package.json'); const required=['check:deps','setup:ytdlp','setup:cloudflared','check:ffmpeg','check:voice','check:config','pm2:check']; const missing=required.filter(name=>typeof p.scripts?.[name]!=='string'); if(missing.length){console.error('Missing required npm scripts: '+missing.join(', ')); process.exit(1)}"
if errorlevel 1 goto :fail
echo [1/7] Installing locked dependencies...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js ci --no-audit --no-fund
if errorlevel 1 goto :fail
echo [2/7] Checking runtime dependencies...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run check:deps
if errorlevel 1 goto :fail
echo [3/7] Preparing yt-dlp...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run setup:ytdlp
if errorlevel 1 goto :fail
echo [4/7] Preparing HTTPS gateway...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run setup:cloudflared
if errorlevel 1 goto :fail
echo [5/7] Checking voice and FFmpeg...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run check:ffmpeg
if errorlevel 1 goto :fail
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run check:voice
if errorlevel 1 goto :fail
echo [6/7] Validating bot tokens, owners and saved bot configuration...
"%MUSIC_RUN_NODE%" scripts/pm2-npm.js run check:config
if errorlevel 1 goto :fail
echo [7/7] Checking the local PM2 deployment...
"%MUSIC_RUN_NODE%" scripts/pm2-preflight.js
if errorlevel 1 goto :fail
echo Installation complete. Existing tokens and saved bot/room settings are preserved. Run start.bat.
echo README.md explains room placement, the web interface and backups.
echo docs\PM2_WINDOWS.md explains PM2 and startup on Windows 11.
pause
exit /b 0
:fail
echo Installation or validation failed. Read the error above.
pause
exit /b 1

@echo off
setlocal
title CraftDeck Launcher
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   Starting CraftDeck...
echo   Browser will open at: http://127.0.0.1:25555
echo   Keep this window open while playing.
echo.

node server\server.mjs --port=25555 --open
if errorlevel 1 goto failed
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Install Node.js 18+ from https://nodejs.org/ and try again.
echo.
pause
exit /b 1

:failed
echo.
echo   [ERROR] CraftDeck failed to start. See messages above.
echo   Manual command:
echo       node server\server.mjs --port=25555 --open
echo.
pause
exit /b 1
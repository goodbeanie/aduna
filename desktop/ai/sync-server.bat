@echo off
cd /d "%~dp0"
node sync-server.js %*
if errorlevel 1 exit /b 1

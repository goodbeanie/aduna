@echo off
cd /d "%~dp0"
node sync-server.js --check
if errorlevel 1 exit /b 1
node logic-test.js
if errorlevel 1 exit /b 1
node ollama-test.js
if errorlevel 1 exit /b 1
node suite-test.js
if errorlevel 1 exit /b 1
node service-test.js
if errorlevel 1 exit /b 1
echo ALL AI TESTS OK

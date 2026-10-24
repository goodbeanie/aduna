@echo off
cd /d "%~dp0"
node agent-test.js
if errorlevel 1 exit /b 1
node ollama-test.js
if errorlevel 1 exit /b 1
node ai-window-test.js
if errorlevel 1 exit /b 1
echo ALL AI TESTS OK

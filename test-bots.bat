@echo off
rem Runs the database-free bot and webhook tests and prints their results (used by the assistant to check work).
cd /d "%~dp0"
echo === webhooks-test ===
node server\webhooks-test.js
echo === botrun-test ===
node server\botrun-test.js
echo === bothost-test ===
node server\bothost-test.js
echo === done ===

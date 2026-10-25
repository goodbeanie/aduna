@echo off
rem Builds the client into a temporary folder to check that the code and CSS compile. Does not touch client\dist.
cd /d "%~dp0client"
if not exist node_modules ( echo node_modules missing: run npm install in client first & exit /b 1 )
node scripts\sync-notifprefs.mjs
call npx vite build --outDir "%TEMP%\aduna-check" --emptyOutDir
echo BUILD EXIT CODE %ERRORLEVEL%
exit /b %ERRORLEVEL%

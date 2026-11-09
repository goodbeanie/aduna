@echo off
rem Syntax-checks the server files and runs the name checker test (no database needed).
cd /d "%~dp0"
node --check server\index.js || ( echo SYNTAX FAIL index.js & exit /b 1 )
node --check server\appropriate.js || ( echo SYNTAX FAIL appropriate.js & exit /b 1 )
node server\appropriate-test.js
echo TEST EXIT CODE %ERRORLEVEL%
exit /b %ERRORLEVEL%

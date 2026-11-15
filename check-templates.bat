@echo off
rem Runs the template, to-do and goals logic tests, then builds the client to catch JSX mistakes.
rem templates-flow-test.js and smoke-test.js need TEST_DATABASE_URL (Postgres), so they run with npm test instead.
cd /d "%~dp0"
node server/templates-test.js || exit /b 1
node server/todo-test.js || exit /b 1
node server/goals-test.js || exit /b 1
node --check server/index.js || exit /b 1
cd client
call npm run build || exit /b 1
echo ALL OK

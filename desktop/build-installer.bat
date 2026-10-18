@echo off
setlocal
cd /d "%~dp0"
title Build Aduna installer

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org, install it, then run this again.
  pause
  exit /b 1
)

echo Installing build tools (first run takes a few minutes)...
call npm install
if errorlevel 1 goto fail

echo.
echo Building the installer...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run dist
if errorlevel 1 goto fail

echo.
echo Done. Your installer is in the dist folder:
dir /b dist\Aduna-Setup*.exe

rem The website keeps only the small update list (latest.yml). The installer itself goes in your R2 "downloads" bucket.
if exist "..\client\public" (
  if not exist "..\client\public\updates" mkdir "..\client\public\updates"
  del /q "..\client\public\updates\*.exe" >nul 2>nul
  copy /y "dist\latest.yml" "..\client\public\updates\" >nul
  echo.
  echo latest.yml copied to client\public\updates. Commit and deploy the site.
)
echo.
echo NOW: upload these two files from the dist folder to your R2 "downloads" bucket:
dir /b dist\Aduna-Setup*.exe dist\Aduna-Setup*.exe.blockmap
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo The build failed. Scroll up to see why.
echo If you see "Cannot create symbolic link", turn on Developer Mode in Windows Settings (Privacy and security, For developers) or right-click this file and choose Run as administrator, then try again.
pause
exit /b 1

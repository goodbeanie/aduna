@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Build Aduna Android app

rem ---------- 1. Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org, install it, then run this again.
  if not defined ZIPPUSH pause
  exit /b 1
)

rem ---------- 2. Java 21 to 23 ----------
rem The Android build only works with Java 21 to 23 (newer ones, like 25, make Gradle fail). Android Studio may ship a newer Java,
rem so every Java found below is tested with "java -version" and the first one that is 21 to 23 is used. Others are ignored.
set "FOUND="
if exist "java-home.txt" (
  set /p CAND=<java-home.txt
  call :try "!CAND!"
)
for /d %%d in ("%ProgramFiles%\Java\jdk-2*" "%ProgramFiles%\Eclipse Adoptium\jdk-2*" "%ProgramFiles%\Microsoft\jdk-2*" "%ProgramFiles%\Amazon Corretto\jdk2*" "%ProgramFiles%\Zulu\zulu-2*" "%ProgramFiles%\BellSoft\LibericaJDK-2*") do call :try "%%~d"
call :try "%ProgramFiles%\Android\Android Studio\jbr"
call :try "%LOCALAPPDATA%\Programs\Android Studio\jbr"
if defined JAVA_HOME call :try "%JAVA_HOME%"
for /f "delims=" %%j in ('where java 2^>nul') do for %%i in ("%%~dpj..") do call :try "%%~fi"
if not defined FOUND (
  echo.
  echo No Java 21 to 23 was found on this PC. ^(Java 24 and newer cannot build this app.^)
  echo Install Temurin 21 from https://adoptium.net or Oracle JDK 21, then run this again.
  echo If it is installed somewhere unusual, put its folder ^(the one containing bin\java.exe^) on the first line of java-home.txt next to this file.
  if not defined ZIPPUSH pause
  exit /b 1
)
set "JAVA_HOME=!FOUND!"
set "PATH=!JAVA_HOME!\bin;%PATH%"
echo Using Java !JV! from !JAVA_HOME!

rem ---------- 3. Android SDK ----------
if not defined ANDROID_HOME (
  if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
)
if not defined ANDROID_HOME (
  echo The Android SDK was not found. Install Android Studio, open it once, and let it download the SDK.
  if not defined ZIPPUSH pause
  exit /b 1
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

rem ---------- 4. Signing + Firebase files (both optional) ----------
rem   aduna.keystore       put it in this folder to build a release APK + AAB for Google Play
rem   google-services.json put it in this folder (from the Firebase console) so push notifications work
set "MODE=debug"
if exist "aduna.keystore" (
  set "MODE=release"
  if not defined ADUNA_KEYSTORE_PASSWORD set /p "ADUNA_KEYSTORE_PASSWORD=Keystore password: "
  if not defined ADUNA_KEY_ALIAS set "ADUNA_KEY_ALIAS=aduna"
  if not defined ADUNA_KEY_PASSWORD set "ADUNA_KEY_PASSWORD=!ADUNA_KEYSTORE_PASSWORD!"
  set "ADUNA_KEYSTORE=%~dp0aduna.keystore"
) else (
  echo No aduna.keystore here: building a DEBUG apk. It installs on your phone but cannot go on Google Play.
)
if not exist "google-services.json" echo No google-services.json here: the app will build but push notifications will not work.

rem Version number: goes up by one on every build (Google Play and the in-app update box both need that)
set /a VC=0
if exist ".versioncode" set /p VC=<.versioncode
set /a VC=VC+1
echo !VC!>.versioncode
set "ADUNA_VERSION_CODE=!VC!"
set "ADUNA_VERSION_NAME=1.0.!VC!"

rem ---------- 5. Build ----------
echo.
echo Installing build tools (first run takes a few minutes)...
call npm install
if errorlevel 1 goto fail

echo.
echo Creating the Android project...
call node scripts\prepare-android.mjs
if errorlevel 1 goto fail

echo.
echo Building the %MODE% app (the first build downloads a lot and can take 10+ minutes)...
pushd android
if "%MODE%"=="release" (
  call gradlew.bat assembleRelease bundleRelease --no-daemon
) else (
  call gradlew.bat assembleDebug --no-daemon
)
set "RC=!errorlevel!"
popd
if not "!RC!"=="0" goto fail

rem ---------- 6. Collect the results ----------
if exist dist rmdir /s /q dist
mkdir dist
copy /y "android\app\build\outputs\apk\%MODE%\*.apk" dist\ >nul 2>nul
copy /y "android\app\build\outputs\bundle\%MODE%\*.aab" dist\ >nul 2>nul
rem The update feed for the phone app (same idea as the desktop latest.yml): put Aduna.apk where the site serves downloads and latest.json in client\public\updates
copy /y "android\app\build\outputs\apk\%MODE%\*.apk" "dist\Aduna.apk" >nul 2>nul
>"dist\latest.json" echo {"versionCode":!VC!,"versionName":"1.0.!VC!","file":"Aduna.apk"}
echo.
echo Done. Your files are in the dist folder:
dir /b dist
if not defined ZIPPUSH start "" "%~dp0dist"
if not defined ZIPPUSH pause
exit /b 0

:fail
echo.
echo The build failed. Scroll up to see why, and send me the red error lines.
if not defined ZIPPUSH pause
exit /b 1

:try
rem call :try "<java folder>": sets FOUND (and JV) when that folder holds a Java 21 to 23. Only the first match is kept.
rem The version is read from the "release" file every JDK has (JAVA_VERSION="21.0.12.1"); java.exe itself is not run.
if defined FOUND exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1\bin\java.exe" exit /b 0
if not exist "%~1\release" exit /b 0
set "TJV="
set "TJM="
for /f "usebackq tokens=1,2 delims==" %%a in ("%~1\release") do if "%%a"=="JAVA_VERSION" set "TJV=%%~b"
if not defined TJV exit /b 0
for /f "delims=." %%m in ("%TJV%") do set "TJM=%%m"
if not defined TJM exit /b 0
if %TJM% GEQ 21 if %TJM% LEQ 23 (
  set "FOUND=%~1"
  set "JV=%TJV%"
)
exit /b 0

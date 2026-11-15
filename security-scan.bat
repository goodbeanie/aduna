@echo off
rem Read-only security scan: committed secrets (current files and history) and dependency audits. Output goes to security-scan.txt
cd /d "%~dp0"
set OUT=security-scan.txt
echo === SECURITY SCAN === > %OUT%

echo. >> %OUT%
echo --- 1. sensitive files that are tracked by git right now --- >> %OUT%
git ls-files | findstr /i /r "\.keystore \.jks \.pem \.p12 \.pfx google-services\.json \.env id_rsa \.sqlite \.db$ secrets" >> %OUT% 2>&1

echo. >> %OUT%
echo --- 2. sensitive files that were EVER committed (history) --- >> %OUT%
git log --all --name-only --pretty=format: | findstr /i /r "\.keystore \.jks \.pem \.p12 \.pfx google-services\.json \.env$ \.env\. id_rsa" | sort /unique >> %OUT% 2>&1

echo. >> %OUT%
echo --- 3. secret-looking strings in tracked files (file:line only, values hidden) --- >> %OUT%
git grep -n -I -l -E "AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |PRIVATE)|sk_live_|sk_test_|ghp_[A-Za-z0-9]{30,}|github_pat_|xox[bp]-|AIza[0-9A-Za-z_-]{30,}|whsec_|postgres(ql)?://[^ :]+:[^ @]+@" -- . ":(exclude)*-test.js" ":(exclude)package-lock.json" >> %OUT% 2>&1

echo. >> %OUT%
echo --- 4. secret-looking strings in git history (commit + file, values hidden) --- >> %OUT%
git log --all -G"AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |PRIVATE)|sk_live_|ghp_[A-Za-z0-9]{30,}|github_pat_|whsec_|postgres(ql)?://[^ :]+:[^ @]+@" --name-only --pretty=format:"commit %%h %%ad" --date=short >> %OUT% 2>&1

echo. >> %OUT%
echo --- 5. npm audit: server (production dependencies) --- >> %OUT%
call npm audit --omit=dev >> %OUT% 2>&1

echo. >> %OUT%
echo --- 6. npm audit: client (production dependencies) --- >> %OUT%
pushd client
call npm audit --omit=dev >> ..\%OUT% 2>&1
popd

echo. >> %OUT%
echo --- 7. npm audit: desktop (production dependencies) --- >> %OUT%
pushd desktop
call npm audit --omit=dev >> ..\%OUT% 2>&1
popd

echo DONE >> %OUT%
echo scan finished

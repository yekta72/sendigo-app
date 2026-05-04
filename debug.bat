@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Klasor: %cd%
echo.
echo --- Node versiyonu ---
node --version
echo.
echo --- npm versiyonu ---
npm --version
echo.
echo --- node_modules klasoru var mi? ---
if exist node_modules (echo EVET) else (echo HAYIR - npm install gerekli)
echo.
echo --- Electron kurulu mu? ---
if exist node_modules\.bin\electron.cmd (echo EVET) else (echo HAYIR)
echo.
echo --- npm install calistiriliyor ---
npm install 2>&1
echo.
echo --- electron baslatiliyor ---
npx electron . 2>&1
echo.
pause

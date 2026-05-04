@echo off
chcp 65001 >nul
title WhatsApp Business Manager

echo.
echo  ====================================
echo   WhatsApp Business Manager
echo  ====================================
echo.

cd /d "%~dp0"
echo  Klasor: %cd%
echo.

:: node_modules zaten varsa direkt ac
if exist node_modules\.bin\electron.cmd (
  echo  Uygulama baslatiliyor...
  node_modules\.bin\electron.cmd .
  goto END
)

:: Yoksa npm install yap
echo  Bagimliliklar yukleniyor (ilk kurulum, bekleyin)...
echo.
call npm install --prefer-offline
echo.
echo  npm install bitti. Electron kontrol ediliyor...

if exist node_modules\.bin\electron.cmd (
  echo  Uygulama baslatiliyor...
  node_modules\.bin\electron.cmd .
) else (
  echo.
  echo  [HATA] node_modules\.bin\electron.cmd bulunamadi!
  echo  Lutfen cmd'den su komutu calistirin:
  echo    npm install
  echo    npx electron .
)

:END
echo.
echo  === Kapandi ===
pause

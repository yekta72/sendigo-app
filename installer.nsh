; ─────────────────────────────────────────────────────────
;  Sendigo — Custom NSIS installer script
;  v4.6.0
;  • Önceki sürümü otomatik kaldırır (HKCU + HKLM)
;  • Oturum verilerini kullanıcı onayıyla temizler
;  • Veri yolu: %APPDATA%\Sendigo  (main.js ile eşleşmeli)
; ─────────────────────────────────────────────────────────

!macro customInit
  ; ── Önceki kurulumu bul: önce HKCU (per-user), sonra HKLM (all-users) ──
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.sendigo.app}" "UninstallString"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.sendigo.app}" "UninstallString"
  ${EndIf}

  ${If} $0 != ""
    DetailPrint "Önceki sürüm kaldırılıyor..."
    ; /S = sessiz kaldırma, _?= kurulum dizinini kilitle (çakışmayı önler)
    ExecWait '"$0" /S _?=$INSTDIR'
    Sleep 1000
  ${EndIf}
!macroend

!macro customInstall
  ; Kurulum tamamlandı — kullanıcıya bilgi ver
  DetailPrint "Sendigo v4.6.0 başarıyla kuruldu."
  DetailPrint "Oturum verileri: $APPDATA\Sendigo"
!macroend

!macro customUnInstall
  ; ── Kullanıcıya WhatsApp oturum verilerini silip silmeyeceğini sor ──
  ; Veri yolu: %APPDATA%\Sendigo  (main.js → app.setPath('userData', 'Sendigo'))
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "WhatsApp oturum verileriniz silinsin mi?$\n$\n\
Konum: $APPDATA\Sendigo$\n$\n\
'Evet' — veriler silinir (QR kodu yeniden taratmanız gerekir)$\n\
'Hayır' — veriler korunur (tekrar kurulumda oturumlar hazır olur)" \
    IDNO sendigo_keep_data

  ; Kullanıcı Evet dedi — oturum verilerini temizle
  RMDir /r "$APPDATA\Sendigo"
  RMDir /r "$LOCALAPPDATA\Sendigo"
  DetailPrint "Oturum verileri silindi."
  Goto sendigo_uninstall_done

  sendigo_keep_data:
  DetailPrint "Oturum verileri korundu — $APPDATA\Sendigo"

  sendigo_uninstall_done:
  DetailPrint "Sendigo kaldırıldı."
!macroend

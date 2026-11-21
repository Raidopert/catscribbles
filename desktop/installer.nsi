; ============================================================
; CatScribbles — NSIS-инсталлятор
; КошачьиЗакорючки · P2P доска для рисования
; (c) 2025–2026 Raido Pert Studio
; Версия 0.1.0
; ============================================================

Unicode true
SetCompressor /SOLID lzma

; Явные пути к include/плагинам NSIS (сборка на Linux из локального тулчейна)
!addincludedir "/home/z/my-project/.tools/nsis-root/usr/share/nsis/Include"
!addplugindir "/home/z/my-project/.tools/nsis-root/usr/share/nsis/Plugins/x86-unicode"

!include "MUI2.nsh"

; --- Брендинг MUI2 ---
!define MUI_ICON            "/home/z/catscribbles/branding/icon.ico"
!define MUI_UNICON          "/home/z/catscribbles/branding/icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "/home/z/catscribbles/branding/nsis-welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP       "/home/z/catscribbles/branding/nsis-header.bmp"
!define MUI_ABORTWARNING

Name "CatScribbles"
OutFile "/home/z/catscribbles/desktop-build/CATSCRIBBLES-Setup-0.1.0.exe"
InstallDir "$PROGRAMFILES64\Raido Pert Studio\CatScribbles"
InstallDirRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "InstallLocation"
RequestExecutionLevel admin

; --- Версия и метаданные установщика ---
VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName"     "CatScribbles"
VIAddVersionKey "CompanyName"     "Raido Pert Studio"
VIAddVersionKey "LegalCopyright"  "© 2025–2026 Raido Pert Studio"
VIAddVersionKey "FileDescription" "CatScribbles — КошачьиЗакорючки, P2P доска для рисования"
VIAddVersionKey "FileVersion"     "0.1.0.0"
VIAddVersionKey "ProductVersion"  "0.1.0.0"

; --- Страницы установщика ---
!define MUI_FINISHPAGE_RUN "$INSTDIR\CatScribbles.exe"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "/home/z/catscribbles/branding/license-notice.txt"

; Дисклеймер — отдельная страница (в MUI2 нет MUI_PAGE_README,
; используем вторую страницу лицензии с собственным заголовком).
!define MUI_PAGE_CUSTOMFUNCTION_PRE "PreDisclaimerPage"
!define MUI_LICENSEPAGE_TEXT_TOP "Прочтите дисклеймер перед продолжением установки."
!insertmacro MUI_PAGE_LICENSE "/home/z/catscribbles/branding/disclaimer.txt"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; --- Страницы деинсталлятора ---
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"

Function PreDisclaimerPage
  !insertmacro MUI_HEADER_TEXT "Дисклеймер" "Важная информация об использовании CatScribbles"
FunctionEnd

; ============================================================
; Установка
; ============================================================
Section "Install"

  SetOutPath "$INSTDIR"

  ; Все файлы приложения (Electron + оболочка CatScribbles)
  File /r "/home/z/catscribbles/desktop-build/win-unpacked/CatScribbles/*.*"

  ; Ярлыки
  CreateDirectory "$SMPROGRAMS\Raido Pert Studio"
  CreateShortCut  "$SMPROGRAMS\Raido Pert Studio\CatScribbles.lnk" "$INSTDIR\CatScribbles.exe"
  CreateShortCut  "$DESKTOP\CatScribbles.lnk" "$INSTDIR\CatScribbles.exe"

  ; Деинсталлятор
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Регистрация в «Установка и удаление программ»
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "DisplayName"     "CatScribbles (КошачьиЗакорючки)"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "DisplayVersion"  "0.1.0"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "Publisher"       "Raido Pert Studio"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "DisplayIcon"     "$INSTDIR\CatScribbles.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES" "InstallLocation" "$INSTDIR"

SectionEnd

; ============================================================
; Удаление
; ============================================================
Section "Uninstall"

  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\Raido Pert Studio\CatScribbles.lnk"
  Delete "$DESKTOP\CatScribbles.lnk"
  RMDir  "$SMPROGRAMS\Raido Pert Studio"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CATSCRIBBLES"

SectionEnd

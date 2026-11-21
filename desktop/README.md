# CatScribbles — Windows EXE (Electron + NSIS), v0.1.0

Установщик `CATSCRIBBLES-Setup-0.1.0.exe` (~82 МБ) собирается на Linux
из портативного Electron (win32-x64) + NSIS 3 (makensis).

## Структура

- `app-electron/main.js` — Electron-обёртка: локальный http-сервер на
  127.0.0.1 раздаёт `web/`, окно BrowserWindow, внешние ссылки — в системный
  браузер, devtools заблокированы, single instance lock.
- `app-electron/package.json` — манифест приложения (productName CatScribbles).
- `app-electron/icon.ico` — иконка exe (генерируется скриптом).
- `installer.nsi` — NSIS-скрипт: MUI2, русский язык, страницы лицензии и
  дисклеймера, ярлыки, запись в «Установка и удаление программ», деинсталлятор.
- `../branding/` — icon.ico, nsis-welcome.bmp (164x314), nsis-header.bmp (150x57),
  license-notice.txt, disclaimer.txt (генерируются скриптом `scripts/make-branding.py`).

## Сборка

1. Брендинг из `icon-512.png`:
   ```sh
   python3 scripts/make-branding.py
   # при обновлении .ico — с bitmap_format="bmp" (NSIS не читает PNG-фреймы):
   # img.save('branding/icon.ico', format='ICO', sizes=[...], bitmap_format='bmp')
   ```
2. Портативный Electron: скачать `electron-v31.7.7-win32-x64.zip` с GitHub
   Releases Electron, распаковать в `desktop-build/win-unpacked/CatScribbles/`,
   переименовать `electron.exe` → `CatScribbles.exe`.
3. Приложение: `resources/app/` ← `app-electron/{package.json, main.js, icon.ico}`
   + `resources/app/web/` ← корень репо (index.html, app.js, sw.js,
   manifest.webmanifest, иконки).
4. NSIS (данные в `/usr/share/nsis`; при локальной распаковке deb — bind-mount
   внутри `unshare -Ur --mount`):
   ```sh
   unshare -Ur --mount sh -c \
     'mount --bind <nsis-root>/usr/share /usr/share && makensis desktop/installer.nsi'
   # → desktop-build/CATSCRIBBLES-Setup-0.1.0.exe
   ```

## Особенности сборки под Linux

- `MUI_ICON`/`MUI_UNICON` требуют ICO с **BMP-фреймами** (PIL: `bitmap_format="bmp"`).
- makensis на Debian ищет данные в абсолютном `/usr/share/nsis`; при распаковке
  deb без root помогает bind-mount в user namespace (`unshare -Ur --mount`).
- Оболочка грузит CDN-модули (esm.sh) и P2P-сигналинг — интернет нужен
  при запуске; `http://127.0.0.1` является secure context, WebRTC работает.

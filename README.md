# CatScribbles — КошачьиЗакорючки · совместная доска для рисования

Бесплатное P2P-приложение для совместного рисования в реальном времени.
Часть раздела «Программы» сайта **raidopert.ru**. Текущая версия: **v0.1.0**.

## Что это

Открытый онлайн-скетч-бук: один создаёт комнату, получает код/ссылку/QR,
второй входит — и оба рисуют на одном холсте одновременно или по очереди.
Рисование, стирание, текст, undo/redo, слои, смена цветов и толщины.
**Без сервера, без регистрации, без сохранения** — комнаты эфемерные.

## Загрузки (установщики)

| Платформа | Файл | Ссылка |
|---|---|---|
| Windows 10/11 (x64) | `CATSCRIBBLES-Setup-0.1.0.exe` (~82 МБ, Electron + NSIS) | [Скачать установщик](https://github.com/Raidopert/catscribbles/releases/download/v0.1.0/CATSCRIBBLES-Setup-0.1.0.exe) |
| Android 7.0+ | `CatScribbles-0.1.0.apk` (~141 КБ, WebView-обёртка) | [Скачать APK](https://github.com/Raidopert/catscribbles/releases/download/v0.1.0/CatScribbles-0.1.0.apk) |
| Веб (любая платформа) | PWA, без установки | [raidopert.ru/catscribbles/](https://raidopert.ru/catscribbles/) |

Все релизы: https://github.com/Raidopert/catscribbles/releases
Установщики — обёртки того же веб-приложения: оболочка (index.html + app.js)
встроена в пакет, CDN-модули и P2P-сигналинг подгружаются из сети при запуске.

## Архитектура (всё бесплатно на Vercel)

| Слой | Технология | Зачем |
|---|---|---|
| Данные | **Yjs** (CRDT) | Конфликт-free слияние штрихов, авто-синхронизация опоздавших |
| Транспорт | **Trystero 0.20.0** (torrent-стратегия) | P2P WebRTC через публичные BitTorrent-трекеры, без своего signaling-сервера |
| NAT-обход | Google + Twilio STUN | Соединение пирингов под обычным NAT |
| Холст | HTML5 Canvas + Pointer Events | Перо/тач/мышь, devicePixelRatio для чётких линий |
| QR | `qrcode` (esm.sh) | Генерация QR-кода для входа с телефона |

**Файлы:**
- `index.html` — разметка, тёмная неон-тема, адаптив (375 / 768 / 1280+)
- `app.js` — вся логика (импортирует Yjs/Trystero/QRCode с esm.sh CDN)

Сборка не нужна — это два статических файла.

## Деплой на Vercel

### Вариант A — рядом с основным сайтом (рекомендуется)

Если основной сайт-визитка уже на Vercel и собран из репозитория GitHub,
просто положите папку `catscribbles/` в `public/` репозитория:

```
your-visit-card-repo/
├── public/
│   └── catscribbles/
│       ├── index.html
│       └── app.js
├── package.json
└── ...
```

После пуша в GitHub Vercel автоматически выложит файлы по адресу:
**`https://raidopert.ru/catscribbles/`**

В меню сайта-визитки добавьте ссылку:
```html
<a href="/catscribbles/">CatScribbles</a>
```

### Вариант B — отдельный Vercel-проект

1. Залейте папку `catscribbles/` в отдельный GitHub-репозиторий (или подпапку).
2. В Vercel: *New Project* → выберите репозиторий.
3. Framework Preset: **Other** (статика).
4. Build Command: пусто. Output Directory: `.` (или `catscribbles/`).
5. Deploy. Привяжите поддомен, например `catscribbles.raidopert.ru`.

### Вариант C — встроить в существующую страницу через iframe

```html
<iframe src="/catscribbles/" style="width:100%;height:600px;border:0;border-radius:12px"
        title="CatScribbles"></iframe>
```

## Интеграция в раздел «Программы» сайта-визитки

Пример карточки приложения (Next.js / HTML):

```html
<a href="/catscribbles/" class="app-card">
  <div class="app-icon" style="font-weight:900;letter-spacing:-.04em;color:#00e5ff;text-shadow:0 0 6px #00e5ff,0 0 14px rgba(0,229,255,.7)">CS</div>
  <h3>CatScribbles</h3>
  <p>Совместная доска для рисования. Без регистрации.</p>
  <span class="app-tag">P2P · бесплатно</span>
</a>
```

## Как пользоваться

1. Открыть `raidopert.ru/catscribbles/` на ПК, Android-браузере или iPhone (Safari 13+).
2. Ввести ник (необязательно) → «Создать комнату».
3. Поделиться кодом (`CS-XXXXXX`), ссылкой или QR — второй человек входит.
4. Рисовать. По умолчанию режим **«одновременно»**.
5. Хост может переключить на **«по очереди»** (кнопка ⇄ в шапке) и передавать ход.
6. Скачать PNG — кнопка ⤓ в тулбаре.

## Поддержка платформ

| Платформа | Статус |
|---|---|
| Chrome / Edge / Firefox (десктоп) | ✅ |
| Safari 13+ (iPhone, iPad) | ✅ |
| Chrome (Android) | ✅ |
| Внутри iframe | ✅ (WebRTC работает из iframe на HTTPS) |

**Требование:** страница должна открываться по **HTTPS** (Vercel даёт это автоматически).
WebRTC не работает с `file://` или по HTTP — только HTTPS или `localhost`.

## Ограничения и нюансы

- **Связь зависит от публичных BitTorrent-трекеров.** Обычно соединение устанавливается за 2–8 секунд. Редко (если трекер перегружен) — дольше. Статус видно в правом нижнем углу холста.
- **Symmetric NAT / корпоративный firewall** могут блокировать P2P. STUN покрывает ~85% домашних сетей; для оставшихся нужен TURN-сервер (платный, в бесплатный тариф не входит). На домашних Wi-Fi и мобильном интернете работает.
- **До 8 одновременных участников** в комнате (технически больше, но UI рассчитан на 8).
- **Комнаты не сохраняются.** Когда все выходят — рисунок исчезает. Перед выходом скачайте PNG.
- **Хост-миграция:** если создатель выходит, хостом автоматически становится следующий участник.
- **Undo/redo** действуют на собственные штрихи (нельзя отменить чужие).
- **Clear Canvas** — только хост.

## Если соединение не устанавливается

1. Проверьте, что оба на `https://` (не `http://`).
2. Подождите 15–20 секунд — первый handshake может быть медленным.
3. Попробуйте обновить страницу обоим.
4. Если не помогло — скорее всего корпоративный firewall режет WebRTC.
   Домашний Wi-Fi / мобильный интернет решают проблему.

## Свои STUN/TURN (опционально)

В `app.js` найдите `RTC_CONFIG` и добавьте свои серверы:

```js
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:your.turn.server', username: '...', credential: '...' },
  ],
};
```

## Лицензия

Свободно для использования и модификации. Часть проекта raidopert.ru.

## Сборка установщиков (Linux-тулчейн)

### Android APK (см. android/README.md)

Инструменты: build-tools 34 (`aapt2`, `d8`, `zipalign`, `apksigner`), platform-34
(`android.jar`), JDK 21. Оболочка — 2 java-файла (`MainActivity`,
`ScribbleWebViewClient`), статику берём из корня репо:

```sh
cp index.html app.js sw.js manifest.webmanifest icon-*.png apple-touch-icon.png android-build/assets/
aapt2 compile --dir android/res -o android-build/res.zip
aapt2 link -o base-unsigned.apk -I android.jar --manifest android/AndroidManifest.xml \
  -A android-build/assets --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 1 --version-name 0.1.0 --auto-add-overlay android-build/res.zip
javac -source 11 -target 11 -cp android.jar -d obj $(find android/java -name '*.java')
d8 --release --lib android.jar --min-api 24 --output dex $(find obj -name '*.class')
# classes.dex → в apk, zipalign -f 4, apksigner sign
```

Keystore: `android/keystore/catscribbles-release.jks`, alias `catscribbles`,
пароли (store и key): `catscribbles2026`. Ключ терять нельзя — обновления
устанавливаются поверх старых только при совпадении подписи.

### Windows EXE (см. desktop/README.md)

1. `python3 scripts/make-branding.py` — mipmaps, .ico, NSIS-битмапы из `icon-512.png`;
2. распаковать portable Electron (win32-x64) в `desktop-build/win-unpacked/CatScribbles/`,
   переименовать `electron.exe` → `CatScribbles.exe`;
3. приложение — в `resources/app/` (`package.json`, `main.js`, `icon.ico`, `web/`);
4. NSIS: `makensis desktop/installer.nsi` → `desktop-build/CATSCRIBBLES-Setup-0.1.0.exe`.

NSIS-данные ищутся в `/usr/share/nsis`; при локальной распаковке deb без root —
bind-mount внутри `unshare -Ur --mount`.

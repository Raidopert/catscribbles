# CatScribbles — Android APK (v0.1.0)

Package `ru.raidopert.catscribbles`, versionCode 1, versionName 0.1.0,
minSdk 24 / targetSdk 34.

Единственное разрешение — `INTERNET`: приложение сетевое (P2P WebRTC,
сигналинг Supabase Realtime, CDN-модули Yjs/Trystero/QRCode с esm.sh,
STUN/TURN для NAT-обхода). Локальная оболочка (index.html + app.js + иконки)
встроена в APK (`assets/`) и раздаётся `ScribbleWebViewClient` (чистый
android.webkit) по адресу `https://appassets.androidplatform.net/assets/...`;
топ-левел навигация на внешние адреса блокируется, подресурсы — нет.
androidx.webkit (WebViewAssetLoader) не используется: локальный d8 8.2.2-dev
(build-tools 34) падает с NPE при дексировании его classes.jar — приём
унаследован от POPCORN PAWS.

## Пересборка (из корня репозитория)

```sh
TOOLS=<путь>/android-build-tools; BT=$TOOLS/android-14; AJ=$TOOLS/android-34/android.jar
export PATH=<путь>/jdk21/bin:$PATH

mkdir -p android-build/assets && cp index.html app.js sw.js manifest.webmanifest \
  icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png android-build/assets/
$BT/aapt2 compile --dir android/res -o android-build/res.zip
$BT/aapt2 link -o android-build/base-unsigned.apk -I $AJ --manifest android/AndroidManifest.xml \
  -A android-build/assets --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 1 --version-name 0.1.0 --auto-add-overlay android-build/res.zip
mkdir -p android-build/obj && javac -nowarn -source 11 -target 11 -cp $AJ \
  -d android-build/obj $(find android/java -name '*.java')
mkdir -p android-build/dex && $BT/d8 --release --lib $AJ --min-api 24 \
  --output android-build/dex $(find android-build/obj -name '*.class')
python3 -c "import zipfile; z=zipfile.ZipFile('android-build/base-unsigned.apk','a'); z.write('android-build/dex/classes.dex','classes.dex',compress_type=zipfile.ZIP_DEFLATED); z.close()"
$BT/zipalign -f 4 android-build/base-unsigned.apk android-build/base-aligned.apk
$BT/apksigner sign --ks android/keystore/catscribbles-release.jks --ks-key-alias catscribbles \
  --ks-pass pass:catscribbles2026 --key-pass pass:catscribbles2026 \
  --out android-build/CatScribbles-0.1.0.apk android-build/base-aligned.apk
$BT/apksigner verify --print-certs android-build/CatScribbles-0.1.0.apk
```

Keystore: `android/keystore/catscribbles-release.jks`, alias `catscribbles`,
пароли (store и key): `catscribbles2026`.
Ключ терять нельзя: обновления устанавливаются поверх старых только при
совпадении подписи (same signature).

Обновление: поднять versionCode/versionName в манифесте и в aapt2 link,
пересобрать по командам выше, проверить подпись, залить APK в новый GitHub Release.

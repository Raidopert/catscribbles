package ru.raidopert.catscribbles;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * WebView-обёртка CatScribbles (КошачьиЗакорючки).
 * Оболочка приложения (index.html + app.js) встроена в APK (assets/)
 * и раздаётся ScribbleWebViewClient по адресу
 * https://appassets.androidplatform.net/assets/...
 *
 * В отличие от офлайн-игры POPCORN PAWS, CatScribbles — сетевое
 * P2P-приложение: app.js подтягивает Yjs/Trystero/QRCode с esm.sh и
 * общается с Supabase (сигналинг) и STUN/TURN. Поэтому в манифесте
 * есть INTERNET, а перехват запросов касается только локальных ассетов.
 */
public class MainActivity extends Activity {

    private WebView wv;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        wv = new WebView(this);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        // localStorage: последние комнаты и настройки кисти
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        // Клиент раздаёт встроенные ассеты по "https"-подобному адресу
        wv.setWebViewClient(new ScribbleWebViewClient(getAssets()));

        setContentView(wv);
        wv.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    @Override
    public void onBackPressed() {
        // Приложение закрывается в фон: комната P2P и незавершённая
        // заметка не должны теряться мгновенно
        moveTaskToBack(true);
    }

    @Override
    protected void onPause() {
        super.onPause();
        wv.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        wv.onResume();
    }

    @Override
    protected void onDestroy() {
        wv.destroy();
        super.onDestroy();
    }
}

'use strict';

/**
 * CatScribbles — КошачьиЗакорючки
 * Electron-обёртка веб-приложения (P2P доска для рисования).
 * (c) 2025–2026 Raido Pert Studio
 */

const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_ROOT = path.join(__dirname, 'web');

// --- MIME-таблица для раздачи статики ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Простые меры против path traversal: path.normalize + проверка,
 * что итоговый путь остаётся внутри WEB_ROOT.
 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(path.join(root, decoded));
  if (normalized !== root && !normalized.startsWith(root + path.sep)) {
    return null;
  }
  return normalized;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/');
  let filePath = safeJoin(WEB_ROOT, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (err2, st2) => {
        if (!err2 && st2.isFile()) serveFile(res, filePath);
        else serveFile(res, path.join(WEB_ROOT, 'index.html'));
      });
      return;
    }
    if (!err && st.isFile()) {
      serveFile(res, filePath);
      return;
    }
    serveFile(res, path.join(WEB_ROOT, 'index.html'));
  });
});

let mainWindow = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: 'CatScribbles',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Блокируем открытие новых окон; внешние http(s) — в системный браузер.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Перехват devtools по клавише: F12 и Ctrl+Shift+I.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isF12 = input.type === 'keyDown' && input.key === 'F12';
    const isCtrlShiftI =
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  Menu.setApplicationMenu(null);
  app.setAppUserModelId('ru.raidopert.catscribbles');

  app.whenReady().then(() => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      createWindow(port);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

// ====================================================================
// CatScribbles (КошачьиЗакорючки) — совместная доска для рисования в реальном времени
// Архитектура:
//   • Yjs (CRDT) — общее состояние (штрихи, мета, ходы)
//   • Supabase Realtime — единый транспорт: broadcast (Yjs-sync + awareness)
//     и Presence (обнаружение пиров). WebSocket — пробивается через VPN/NAT/
//     корп. фаерволы, в отличие от WebRTC data-channel.
//   • Supabase-таблица catscribbles_rooms — авто-persistence (заметка переживает закрытие)
// P2P WebRTC убран: data-channel не открывался у части юзеров (VPN, symmetric NAT),
// поэтому sync, awareness и presence — всё через Supabase Realtime (server-relayed).
// ====================================================================

// Зависимости вендорены локально (./vendor/) — никаких внешних CDN для модулей.
// В РФ esm.sh/telegram.org часто режутся VPN-блокировками → приложение не грузилось.
// supabase-js — UMD-скриптом в index.html (window.supabase), jspdf — lazy (loadJsPDF).
import * as Y from './vendor/yjs.js?v=20';
import QRCode from './vendor/qrcode.js?v=20';
const supabaseLib = window.supabase;
if (!supabaseLib || typeof supabaseLib.createClient !== 'function') {
  throw new Error('Supabase SDK не загрузился (vendor/supabase.umd.min.js). Обновите страницу.');
}
const { createClient } = supabaseLib;

// Lazy-загрузка тяжёлых UMD-библиек локальным <script> (без внешних CDN).
// jspdf (365KB) нужен только при экспорте PDF — не грузим его на старте.
function lazyScript(src, globalCheck, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (globalCheck()) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => { if (globalCheck()) resolve(); else reject(new Error(`${src}: loaded but global missing`)); };
    s.onerror = () => reject(new Error(`${src} не загрузился`));
    document.head.appendChild(s);
    setTimeout(() => { if (globalCheck()) resolve(); else reject(new Error(`${src} timeout`)); }, timeoutMs);
  });
}
let _jspdfPromise = null;
function loadJsPDF() {
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = lazyScript('./vendor/jspdf.umd.min.js?v=20', () => window.jspdf && window.jspdf.jsPDF)
    .then(() => window.jspdf.jsPDF)
    .catch(e => { _jspdfPromise = null; throw e; });
  return _jspdfPromise;
}

// ============ Константы ============
const APP_ID = 'raidopert.catscribbles.v1';
const MAX_PARTICIPANTS = 8;
const PALETTE = ['#00e5ff', '#ff2bd6', '#00ff88', '#ffb800', '#a78bff', '#ff5470', '#ff8a3d', '#ffffff'];
const USER_COLORS = ['#00e5ff', '#ff2bd6', '#00ff88', '#ffb800', '#a78bff', '#ff5470', '#00d4ff', '#ff8a3d'];
const ROOM_PREFIX = 'CS-';
// Supabase: Realtime (сигналинг) + таблица catscribbles_rooms (авто-persistence).
// Publishable-ключ безопасен для клиентского кода (как Firebase web-config);
// RLS таблицы разрешает anon только читать/писать строки комнат.
const SB_URL = 'https://gpwsnefhaiawoigqdnnr.supabase.co';
const SB_KEY = 'sb_publishable_edH7sk8jpGTBLDG9F4G8mA_2HCDsOR-';
const SB_TABLE = 'catscribbles_rooms';
const SB_REST = SB_URL + '/rest/v1/' + SB_TABLE;

// Supabase-клиент для Realtime-broadcast (надёжная доставка штрихов + presence
// через WSS — работает там, где WebRTC data-channel не пробивается: VPN,
// symmetric NAT, корп. фаерволы). Trystero/P2P убран: sync, awareness и
// presence — всё через Supabase Realtime.
const sb = createClient(SB_URL, SB_KEY);

// Uint8Array ↔ base64 (Realtime-broadcast payload должен быть JSON-сериализуем).
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ============ Утилиты ============
function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
// Персистентный id пользователя (в localStorage) — замена Trystero selfId.
// Стабилен между перезагрузками → хост-миграция и rejoin работают корректно.
function localUserId() {
  try {
    const k = 'cs_uid_v1';
    let id = localStorage.getItem(k);
    if (!id) { id = 'u-' + uuid(); localStorage.setItem(k, id); }
    return id;
  } catch (e) { return 'u-' + uuid(); }
}
function genRoomCode() {
  // 4 символа из алфавита без похожих (без I,O,0,1) — ~1 млн комбинаций, легко ввести/сканировать
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return ROOM_PREFIX + s;
}
function roomCodeToTopic(code) {
  return APP_ID + ':' + code.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function showToast(msg, type = '', ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = type;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

// ============ Состояние ============
const state = {
  ydoc: null,
  room: null,
  yStrokes: null,    // Y.Array<stroke>
  yMeta: null,       // Y.Map: { hostId, mode, currentTurn, turnOrder }
  roomId: null,
  roomCode: null,
  snapshotDropped: false,  // рисунок не влез в ссылку (>1800 символов) — показываем предупреждение
  userId: localUserId(),    // персистентный id (localStorage) — замена Trystero selfId
  nick: '',
  userColor: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  isHost: false,
  tool: 'pen',
  color: '#00e5ff',
  size: 4,
  layer: 0,
  isDrawing: false,
  currentStroke: null,
  undoStack: [],
  redoStack: [],
  peers: 0,
  peerUserId: new Map(),    // peerId -> userId (из awareness)
  peerAwareness: new Map(), // peerId -> { id, nick, color, cursor, drawing, liveStroke }
  _cursor: null,
  _cursorThrottle: null,
  _awareThrottle: null,
  destroyed: false,
};

// DEBUG: экспонируем состояние для диагностики из консоли (временно)
window.__cs = state;

// ============ DOM ============
const landing = $('#landing');
const roomEl = $('#room');
const stage = $('#stage');
const mainCanvas = $('#canvas-main');
const liveCanvas = $('#canvas-live');
const mainCtx = mainCanvas.getContext('2d');
const liveCtx = liveCanvas.getContext('2d');

// ============ Лендинг: табы ============
$$('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('#pane-create').hidden = tab !== 'create';
    $('#pane-join').hidden = tab !== 'join';
    if (tab === 'join') $('#join-code').focus();
    else $('#create-nick').focus();
  });
});

// ============ Лендинг: создать / войти ============
const NICK_KEY = 'cs_nick';
// Принять и код (CS-XXXX), и полную ссылку (https://.../#room=CS-XXXX) — извлечь код.
function parseRoomCode(raw) {
  if (!raw) return '';
  let s = raw.trim();
  const m = s.match(/room=([A-Z0-9-]+)/i) || s.match(/(CS[-]?[A-Z0-9]{4,8})/i);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/\s+/g, '');
  if (!s.startsWith(ROOM_PREFIX)) s = ROOM_PREFIX + s.replace(ROOM_PREFIX, '');
  return s;
}
function saveNick(n) { try { if (n) localStorage.setItem(NICK_KEY, n.slice(0, 20)); } catch (_) {} }
function loadNick() { try { return localStorage.getItem(NICK_KEY) || ''; } catch (_) { return ''; } }

$('#btn-create').addEventListener('click', () => {
  const nick = $('#create-nick').value.trim();
  state.nick = nick; saveNick(nick);
  const code = genRoomCode();
  state.isHost = true;
  enterRoom(code);
  // Сразу показываем ссылку+QR — хосту надо только отправить её другу.
  setTimeout(openShareModal, 500);
});

$('#btn-join').addEventListener('click', () => {
  const code = parseRoomCode($('#join-code').value);
  const nick = $('#join-nick').value.trim();
  state.nick = nick; saveNick(nick);
  $('#join-code').value = code;
  if (!code) { showToast('Введите код комнаты или ссылку', 'error'); $('#join-code').focus(); return; }
  enterRoom(code);
});

$('#join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});
$('#join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#create-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-create').click(); });
$('#join-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
// Предзаполнение ника из предыдущего визита.
(function prefillNick() {
  const n = loadNick();
  if (n) { $('#create-nick').value = n; $('#join-nick').value = n; }
})();

// Автовход по URL hash (#room=CS-XXXXXX)
(function autoJoinFromHash() {
  const m = location.hash.match(/room=([A-Z0-9-]+)/i);
  if (m) {
    let code = m[1].toUpperCase();
    if (!code.startsWith(ROOM_PREFIX)) code = ROOM_PREFIX + code.replace(ROOM_PREFIX, '');
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'join'));
    $('#pane-create').hidden = true;
    $('#pane-join').hidden = false;
    $('#join-code').value = code;
    setTimeout(() => $('#btn-join').click(), 250);
  }
})();

// ============ Недавние заметки (локальный список на лендинге) ============
const RECENT_KEY = 'cs_recent_v1';
function getRecentRooms() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; }
}
function addRecentRoom(code, nick) {
  if (!code) return;
  try {
    const list = getRecentRooms().filter(r => r.code !== code);
    list.unshift({ code, nick: nick || '', ts: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch (e) {}
}
function fmtWhen(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  return Math.floor(s / 86400) + ' д назад';
}
function renderRecentRooms() {
  const wrap = $('#recent-rooms');
  const list = $('#recent-list');
  if (!wrap || !list) return;
  const items = getRecentRooms();
  if (items.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = '';
  for (const r of items) {
    const el = document.createElement('div');
    el.className = 'recent-item';
    el.innerHTML =
      '<span class="ri-code">' + r.code + '</span>' +
      (r.nick ? '<span class="ri-nick" style="color:var(--text-mute);font-size:.8rem">' + r.nick + '</span>' : '') +
      '<span class="ri-when">' + fmtWhen(r.ts) + '</span>' +
      '<span class="ri-arrow">→</span>';
    el.addEventListener('click', () => {
      $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'join'));
      $('#pane-create').hidden = true;
      $('#pane-join').hidden = false;
      $('#join-code').value = r.code;
      $('#btn-join').click();
    });
    list.appendChild(el);
  }
}
renderRecentRooms();

// ============ Шеринг-модалка ============
const shareModal = $('#share-modal');

async function openShareModal() {
  const link = buildRoomLink();
  $('#share-code').textContent = state.roomCode;
  $('#share-link').textContent = link;
  const qrWrap = $('#qr-wrap');
  qrWrap.innerHTML = '';
  const hasDrawing = state.yStrokes && state.yStrokes.length > 0;
  // QR теряет читаемость на длинных ссылках (рисунок в hash). До ~1200 символов — рисуем.
  if (link.length > 1200) {
    qrWrap.textContent = 'Рисунок большой — QR не уместится. Скопируйте ссылку выше.';
    qrWrap.style.color = 'var(--text-mute)';
    qrWrap.style.fontSize = '.82rem';
    qrWrap.style.background = 'transparent';
    qrWrap.style.padding = '12px';
    qrWrap.style.textAlign = 'center';
  } else {
    try {
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, link, { width: 200, margin: 1, color: { dark: '#0a0d12', light: '#ffffff' } });
      qrWrap.appendChild(canvas);
    } catch (e) {
      console.warn('QR generation failed', e);
      qrWrap.textContent = 'QR недоступен';
    }
  }
  const hint = document.getElementById('share-hint');
  if (hint) {
    hint.innerHTML = hasDrawing
      ? 'В ссылке уже зашит ваш рисунок — друг увидит его, <b>даже если вы уже закрыли приложение</b>. Если оба онлайн — рисуете вместе вживую.'
      : 'Покажите код или QR второму человеку. На телефоне QR удобно сканировать камерой.';
  }
  shareModal.classList.add('show');
  // Баннер статуса сохранения: объясняет, дойдёт ли рисунок по ссылке.
  const statusEl = document.getElementById('share-status');
  if (statusEl) {
    const dbOk = state.persistStats && state.persistStats.save === 'ok';
    if (dbOk) {
      statusEl.hidden = false; statusEl.className = 'share-status ok';
      statusEl.textContent = '✓ Рисунок сохранён на сервере — ссылка короткая, друг увидит его даже после вашего ухода.';
    } else if (state.snapshotDropped) {
      statusEl.hidden = false; statusEl.className = 'share-status';
      statusEl.innerHTML = '⚠ Сервер сохранения недоступен (возможно, Supabase заблокирован в вашей сети), а рисунок слишком большой для ссылки. <b>Совместный режим в реальном времени может не работать.</b> Передайте код комнаты — он работает, пока оба онлайн. Если приложение не грузится у друга — пусть включит VPN.';
    } else {
      statusEl.hidden = false; statusEl.className = 'share-status';
      statusEl.innerHTML = '⚠ Сервер сохранения недоступен (возможно, Supabase заблокирован в вашей сети). Рисунок зашит в ссылку как фолбэк — но <b>совместный режим в реальном времени может не работать.</b> Если у друга не грузится — пусть включит VPN и обновит страницу.';
    }
  }
  // В Telegram — дополнительная кнопка шеринга в чат.
  const old = document.getElementById('tg-share-row'); if (old) old.remove();
  const tgBtn = tgShareButton(link);
  if (tgBtn) { const row = document.createElement('div'); row.id = 'tg-share-row'; row.appendChild(tgBtn); shareModal.querySelector('.modal').appendChild(row); }
}
function closeShareModal() { shareModal.classList.remove('show'); }

$('#share-close').addEventListener('click', closeShareModal);
shareModal.addEventListener('click', e => { if (e.target === shareModal) closeShareModal(); });
// Нативный шеринг (мобильные): одной кнопкой отправить ссылку в WhatsApp/Telegram/SMS.
const nativeShareBtn = $('#btn-native-share');
if (nativeShareBtn && navigator.share) nativeShareBtn.hidden = false;
if (nativeShareBtn) nativeShareBtn.addEventListener('click', async () => {
  const link = buildRoomLink();
  try { await navigator.share({ title: 'CatScribbles', text: 'Нарисуй мне ответ ✏️', url: link }); }
  catch (_) {}
});

$$('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = $('#' + btn.dataset.copy);
    const ok = await copyText(target.textContent);
    if (ok) { showToast('Скопировано', 'success', 1200); btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Копир.', 1000); }
    else showToast('Не удалось скопировать', 'error');
  });
});

function buildRoomLink() {
  // Гарантируем, что в hash лежит свежий snapshot (если есть штрихи) —
  // тогда скопированная ссылка несёт рисунок как «заметку».
  updateHashWithSnapshot();
  return location.origin + location.pathname + location.hash;
}

// ============ Persistence: рисунок живёт в URL hash ============
// В чистом P2P нет сервера, поэтому «заметка для того, кто откроет ссылку позже»
// кодируется прямо в hash: #room=CS-XXXXXX&d=<base64url(Y.encodeStateAsUpdate)>.
// Это ФОЛБЭК: когда Supabase-таблица жива (db:ok), рисунок хранится на сервере и
// ссылка остаётся короткой. Live-синхрон (Realtime) работает поверх, когда оба онлайн.
function bytesToB64Url(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64UrlToBytes(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function encodeSnapshot() {
  try {
    if (!state.ydoc) return '';
    const u = Y.encodeStateAsUpdate(state.ydoc);
    return bytesToB64Url(u);
  } catch (e) { console.warn('encodeSnapshot', e); return ''; }
}
function applySnapshot(b64) {
  try {
    if (!state.ydoc || !b64) return false;
    const u = b64UrlToBytes(b64);
    if (!u || u.length < 2) return false;
    // origin 'snapshot' (не 'remote') → локальный update-хендлер рассылит его
    // уже подключённым пирам, а observe(onStrokesChange) перерисует холст.
    Y.applyUpdate(state.ydoc, u, 'snapshot');
    return true;
  } catch (e) { console.warn('applySnapshot', e); return false; }
}
function readSnapshotFromHash() {
  const m = location.hash.match(/[?&]d=([^&]+)/) || location.hash.match(/\bd=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
// ============ Supabase persistence (авто-сохранение рисунка в БД) ============
// publishable-ключ = роль anon; RLS таблицы разрешает читать/писать строки комнат.
// Если таблицы/RLS нет — save/load тихо падает, фолбэком остаётся URL-hash (d=).
state.persistStats = { load: 'pending', save: 'pending', lastErr: '', dirty: false };
const SB_HDR = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

async function sbLoadState(roomId) {
  try {
    const r = await fetch(`${SB_REST}?room_id=eq.${encodeURIComponent(roomId)}&select=state&limit=1`, { headers: SB_HDR });
    if (!r.ok) { state.persistStats.lastErr = 'load ' + r.status; return null; }
    const arr = await r.json();
    state.persistStats.load = arr && arr[0] && arr[0].state ? 'ok' : 'empty';
    return (arr && arr[0] && arr[0].state) ? arr[0].state : null;
  } catch (e) { state.persistStats.lastErr = 'load ' + e.message; return null; }
}
async function sbSaveState(roomId, b64, { keepalive = false } = {}) {
  try {
    const r = await fetch(SB_REST + '?on_conflict=room_id', {
      method: 'POST',
      headers: { ...SB_HDR, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ room_id: roomId, state: b64, updated_at: new Date().toISOString() }),
      keepalive,
    });
    state.persistStats.save = r.ok ? 'ok' : 'err' + r.status;
    if (r.ok) state.persistStats.dirty = false;   // изменения сброшены в БД
    else state.persistStats.lastErr = 'save ' + r.status;
    updateHashWithSnapshot();   // переоценить hash: убрать d= когда db:ok (ссылка станет короткой)
    updateSaveIndicator();      // точка: зелёная (saved) / красная (err)
    return r.ok;
  } catch (e) {
    state.persistStats.save = 'err';
    state.persistStats.lastErr = 'save ' + e.message;
    updateSaveIndicator();
    return false;
  }
}

let _persistTimer = null;
let _reconnectTimer = null;   // grace-таймер «Переподключение…» (12с) при потере пиров
function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistNow, 1500);
}
function persistNow() {
  if (!state.ydoc || state.destroyed || !state.roomId) return;
  updateHashWithSnapshot();                 // 1) URL-hash (фолбэк + share-link несёт рисунок)
  const strokes = state.yStrokes ? state.yStrokes.length : 0;
  if (strokes > 0) {                        // 2) Supabase-таблица (авто-persistence)
    const snap = encodeSnapshot();
    if (snap) sbSaveState(state.roomId, snap);
  }
}
// Флаш при закрытии вкладки: keepalive-запрос переживает unload — заметка сохранится.
function flushPersistOnExit() {
  if (!state.ydoc || state.destroyed || !state.roomId) return;
  try { state.rtChannel && state.rtChannel.untrack(); } catch(e){}  // быстрый leave для presence
  const strokes = state.yStrokes ? state.yStrokes.length : 0;
  if (strokes > 0) {
    const snap = encodeSnapshot();
    if (snap) sbSaveState(state.roomId, snap, { keepalive: true });
  }
}
// Индикатор несохранённых изменений: точка на room-badge.
//   зелёная — сохранено на сервере (db:ok, нет pending-изменений)
//   янтарная (пульс) — изменения ждут сброса в БД (debounce 1.5с / идёт запрос)
//   красная — последний save упал (данные всё равно в URL-ссылке — фолбэк)
function markDirty() {
  if (!state.persistStats) return;
  state.persistStats.dirty = true;
  updateSaveIndicator();
}
function updateSaveIndicator() {
  const badge = $('#room-badge');
  if (!badge) return;
  const ps = state.persistStats || {};
  badge.classList.remove('saving', 'err');
  const saveErr = typeof ps.save === 'string' && ps.save.startsWith('err');
  if (saveErr) {
    badge.classList.add('err');
    badge.title = 'Не сохранено на сервер — рисунок в ссылке (фолбэк). Нажмите «Сохранить».';
  } else if (ps.dirty) {
    badge.classList.add('saving');
    badge.title = 'Сохранение…';
  } else {
    badge.title = 'Сохранено. Нажмите, чтобы поделиться.';
  }
}
// Явное сохранение заметки по кнопке в topbar. Даёт пользователю уверенность
// (toast), что рисунок сохранён на сервере (db:ok) либо в ссылке (фолбэк).
async function saveNote() {
  if (!state.ydoc || state.destroyed || !state.roomId) return;
  const strokes = state.yStrokes ? state.yStrokes.length : 0;
  if (strokes === 0) { showToast('Пусто — нечего сохранять', '', 1600); return; }
  showToast('Сохраняю…', '', 1400);
  updateHashWithSnapshot();
  const snap = encodeSnapshot();
  if (!snap) { showToast('Не удалось сохранить', 'error', 2000); return; }
  const ok = await sbSaveState(state.roomId, snap);
  if (ok) showToast('Заметка сохранена ✓', 'success', 1900);
  else showToast('Сохранено в ссылке', '', 2000);
}
function updateHashWithSnapshot() {
  if (!state.ydoc || state.destroyed || !state.roomCode) return;
  const strokes = state.yStrokes ? state.yStrokes.length : 0;
  let hash = 'room=' + encodeURIComponent(state.roomCode);
  // d= (рисунок в ссылке) — только как ФОЛБЭК, когда Supabase не сохраняет.
  // Если БД жива (save=ok) — ссылка остаётся короткой (#room=CS-XXXXXX), а рисунок
  // подгружается с сервера при открытии. Так QR/ссылка не разбухают.
  const dbOk = state.persistStats && state.persistStats.save === 'ok';
  state.snapshotDropped = false;
  if (strokes > 0 && !dbOk) {
    const snap = encodeSnapshot();
    if (snap) {
      // Кап длины: если ссылка с d= превышает 1800 символов — не зашиваем рисунок
      // (длинные URL режутся мессенджерами/браузерами → ссылка ломается).
      // Ссылка остаётся короткой (#room=CS-XXXX),live-sync работает, если оба онлайн.
      const fullUrl = location.origin + location.pathname + '#' + hash + '&d=' + snap;
      if (fullUrl.length <= 1800) {
        hash += '&d=' + snap;
      } else {
        state.snapshotDropped = true;
      }
    }
  }
  const cur = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (cur !== hash) {
    history.replaceState(null, '', '#' + hash);
  }
}

// ============ Вход в комнату ============
async function enterRoom(code) {
  state.roomCode = code;
  state.roomId = roomCodeToTopic(code);

  // 1) Yjs-документ
  const ydoc = new Y.Doc();
  state.ydoc = ydoc;
  state.yStrokes = ydoc.getArray('strokes');
  state.yMeta = ydoc.getMap('meta');

  // 2) Trystero-комната (supabase-стратегия: Realtime-каналы + STUN/TURN).
  //    appId здесь = URL Supabase (особенность стратегии), supabaseKey = publishable.
  // 3) Yjs sync + awareness + presence — всё через Supabase Realtime (WebSocket).
  //    Надёжно пробивается через VPN/NAT; P2P WebRTC data-channel на таких сетях
  //    не открывается, поэтому отказались от Trystero в пользу Realtime-broadcast.
  state.rtChannel = setupRealtimeSync(ydoc, state.roomId);
  setupAwareness(state.rtChannel);

  // 5) Инициализация меты: создатель — хост
  if (state.isHost) {
    ydoc.transact(() => {
      state.yMeta.set('hostId', state.userId);
      state.yMeta.set('mode', 'simultaneous');
      state.yMeta.set('currentTurn', state.userId);
      state.yMeta.set('turnOrder', [state.userId]);
    });
  }

  // 6) Реакции на изменения общего состояния
  state.yStrokes.observe(onStrokesChange);
  state.yMeta.observe(onMetaChange);

  // 7) Presence теперь обрабатывается в setupRealtimeSync (Realtime Presence:
  //    join/leave/sync). Trystero onPeerJoin/onPeerLeave больше не используются.

  // 8) UI
  landing.style.display = 'none';
  roomEl.classList.add('active');
  $('#room-code-display').textContent = code;
  addRecentRoom(code, state.nick);   // запомнить в локальном списке «Недавние»

  initCanvas();
  // Восстановить рисунок. Сначала из URL-hash (мгновенно, локально) — чтобы тот,
  // кто открыл ссылку позже, сразу увидел «заметку». Затем асинхронно из Supabase
  // (актуальнее — может быть новее, если кто-то дорисовал после создания ссылки).
  // Yjs-merge по client/clock: повторное применение не дублирует штрихи.
  const _snap = readSnapshotFromHash();
  if (_snap) applySnapshot(_snap);
  // Авто-persistence: загрузить последнее сохранённое состояние комнаты из БД.
  (async () => {
    const dbState = await sbLoadState(state.roomId);
    if (dbState) {
      applySnapshot(dbState);
      updateEmptyHint();
    }
  })();
  // Флаш при закрытии вкладки — чтобы «заметка» точно сохранилась.
  window.addEventListener('beforeunload', flushPersistOnExit, { once: false });
  buildSwatches();
  setupToolbar();
  setupInstall();
  setupTemplates();
  setupAI();
  setupTelegram();
  setupStickyEdit();
  setupTopbar();
  updateModeUI();
  updateConnStatus();
  updateParticipants();   // показать свой аватар сразу
  updateSaveIndicator();  // точка сохранения: стартовое состояние
  showOnboarding();       // разовый онбординг (один раз на браузер)
  pushAwareness();
  refreshHostUI();
  updateHashWithSnapshot();   // зафиксировать base-hash (room=…, без d если пусто)
  updateEmptyHint();          // подсказка на пустом холсте

  // Debug-бар: только по ?debug (по умолчанию скрыт для чистого вида)
  if (new URLSearchParams(location.search).has('debug')) {
    document.getElementById('debug-bar').classList.add('show');
  }
  startDebugBar();

  // Если создатель — сразу показать шеринг-модалку
  if (state.isHost) {
    setTimeout(openShareModal, 400);
  }

  // Resize
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

  console.log('[CatScribbles] room joined', state.roomCode, 'as', state.userId.slice(0, 8));
}

// ============ Yjs sync через Supabase Realtime broadcast ============
// Доставка штрихов идёт по WebSocket (Supabase Realtime), а не по WebRTC data-channel.
// Это надёжно пробивается через VPN, symmetric NAT и корпоративные фаерволы —
// P2P data-channel (Trystero makeAction) на таких сетях не открывается.
// События канала:
//   • 'sync'  — полный state-as-update (новый подписчик получает актуальный рисунок)
//   • 'u'     — инкрементальный update (рассылаем при каждом локальном изменении)
// Возвращает realtime-канал.
function setupRealtimeSync(ydoc, roomId) {
  const stats = { rtSent: 0, rtRecv: 0, syncSent: 0, syncRecv: 0, applyOk: 0, applyFail: 0, subStatus: 'pending', lastErr: '' };
  state.syncStats = stats;

  const chan = sb.channel('cs:' + roomId, {
    config: { broadcast: { self: false }, presence: { key: state.userId } },
  });

  // ===== Presence (обнаружение пиров) через Supabase Realtime =====
  // Надёжнее Trystero onPeerJoin/onPeerLeave: работает на любом WebView/VPN,
  // т.к. это тот же WebSocket, что и broadcast. Драйвит state.peers + conn-status.
  const onPeerHere = (p) => {
    if (!p || !p.id || p.id === state.userId) return;
    state.peers++;
    if (state.reconnecting) {                 // обрыв → связь восстановлена
      state.reconnecting = false;
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
      showToast('Связь восстановлена', 'success', 1600);
    }
    state.hadPeers = true;
    if (p.nick || p.color) {
      state.peerAwareness.set(p.id, { id: p.id, nick: p.nick, color: p.color });
      state.peerUserId.set(p.id, p.id);
    }
    updateConnStatus();
    updateParticipants();
    pushAwareness();
  };
  const onPeerGone = (p) => {
    if (!p || !p.id || p.id === state.userId) return;
    state.peers = Math.max(0, state.peers - 1);
    state.peerAwareness.delete(p.id);
    state.peerUserId.delete(p.id);
    if (state.peers === 0 && state.hadPeers && !state.reconnecting) {
      state.reconnecting = true;
      updateConnStatus();
      if (_reconnectTimer) clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(() => { state.reconnecting = false; _reconnectTimer = null; updateConnStatus(); }, 12000);
    } else {
      updateConnStatus();
    }
    updateParticipants();
    redrawOverlay();
    if (p.id && state.yMeta.get('hostId') === p.id) migrateHost();
  };
  chan.on('presence', { event: 'join' }, ({ newPresences }) => (newPresences || []).forEach(onPeerHere));
  chan.on('presence', { event: 'leave' }, ({ leftPresences }) => (leftPresences || []).forEach(onPeerGone));
  // sync — полный снимок presence (приходит после подписки/переподключения):
  // сверяем с известными, чтобы не потерять и не задвоить счётчик.
  chan.on('presence', { event: 'sync' }, () => {
    try {
      const pres = chan.presenceState() || {};
      const ids = Object.keys(pres).filter(id => id !== state.userId);
      const known = new Set([...state.peerAwareness.keys()].filter(id => id !== state.userId));
      let added = 0, removed = 0;
      for (const id of ids) { if (!known.has(id)) { const arr = pres[id]; if (arr && arr[0]) onPeerHere(arr[0]); added++; } }
      for (const id of known) { if (!ids.includes(id)) { onPeerGone({ id }); removed++; } }
    } catch (e) { stats.lastErr = 'pres-sync:' + e.message; }
  });

  // Получили полный state — применяем (пришёл от уже сидящего в комнате пира)
  chan.on('broadcast', { event: 'sync' }, ({ payload }) => {
    stats.syncRecv++;
    try { Y.applyUpdate(ydoc, b64ToU8(payload), 'remote'); stats.applyOk++; }
    catch (e) { stats.applyFail++; stats.lastErr = 'sync:' + e.message; console.warn('rt sync apply failed', e); }
  });

  // Получили запрос актуального state — отвечаем своим полным state.
  // Нужно для поздних joiner'ов: они подписались после того, как мы отправили
  // свой sync при SUBSCRIBED, и тот до них не дошёл. По запросу — переотправляем.
  chan.on('broadcast', { event: 'req' }, () => {
    try {
      const full = Y.encodeStateAsUpdate(ydoc);
      if (full.byteLength > 2) {
        chan.send({ type: 'broadcast', event: 'sync', payload: u8ToB64(full) });
        stats.syncSent++;
      }
    } catch (e) { stats.lastErr = 'req-reply:' + e.message; }
  });

  // Получили инкрементальный update — применяем
  chan.on('broadcast', { event: 'u' }, ({ payload }) => {
    stats.rtRecv++;
    try { Y.applyUpdate(ydoc, b64ToU8(payload), 'remote'); stats.applyOk++; }
    catch (e) { stats.applyFail++; stats.lastErr = 'u:' + e.message; console.warn('rt update apply failed', e); }
  });

  // Локальное изменение Yjs-документа — рассылаем инкрементальный update всем
  ydoc.on('update', (update, origin) => {
    if (origin === 'remote') return;          // не эхим чужие обновления
    try {
      chan.send({ type: 'broadcast', event: 'u', payload: u8ToB64(update) });
      stats.rtSent++;
    } catch (e) { /* канал ещё не подписан / отвал — persistence подстрахует */ }
  });

  // Подписка установлена:
  //   • рассылаем свой полный state (получат те, кто уже в канале)
  //   • шлём req — попросим актуальный state у уже сидящих (для нас как late-joiner)
  chan.subscribe((status, err) => {
    stats.subStatus = status;
    if (status === 'SUBSCRIBED') {
      try {
        // Заявляем о своём присутствии (presence) — другие пиры увидят join.
        chan.track({ id: state.userId, nick: state.nick || ('user-' + state.userId.slice(0, 4)), color: state.userColor });
        const full = Y.encodeStateAsUpdate(ydoc);
        if (full.byteLength > 2) {
          chan.send({ type: 'broadcast', event: 'sync', payload: u8ToB64(full) });
          stats.syncSent++;
        }
        chan.send({ type: 'broadcast', event: 'req', payload: { t: 1 } });
      } catch (e) { stats.lastErr = 'sub:' + e.message; }
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      stats.lastErr = status;
    }
  });

  return chan;
}

// ============ Awareness (курсоры, ник, цвет, live-штрих) ============
let sendAware = null, onAware = null;

function setupAwareness(chan) {
  // Awareness (курсоры, ник, цвет, live-штрих) — через Realtime broadcast,
  // как и Yjs-sync. Ключуется по userId (state.userId).
  chan.on('broadcast', { event: 'aware' }, ({ payload: data }) => {
    if (!data || !data.id) return;
    state.peerAwareness.set(data.id, data);
    state.peerUserId.set(data.id, data.id);
    updateParticipants();
    redrawOverlay();
  });
}

function pushAwareness(extra = {}) {
  if (!state.rtChannel) return;
  const payload = {
    id: state.userId,
    nick: state.nick || ('user-' + state.userId.slice(0, 8)),
    color: state.userColor,
    cursor: state._cursor || null,
    drawing: state.isDrawing,
    liveStroke: state.isDrawing ? state.currentStroke : null,
    ...extra,
  };
  try { state.rtChannel.send({ type: 'broadcast', event: 'aware', payload }); } catch (e) { /* ignore */ }
}

// Throttled awareness push для курсора (30 Гц)
function pushCursorAwareness() {
  if (state._awareThrottle) return;
  state._awareThrottle = setTimeout(() => {
    state._awareThrottle = null;
    pushAwareness();
  }, 33);
}

// ============ Метаданные: хост, режим, ходы ============
function migrateHost() {
  const order = state.yMeta.get('turnOrder') || [];
  const present = order.filter(id => isUserPresent(id));
  if (present.length === 0) return;
  const newHost = present[0];
  if (newHost === state.userId) {
    state.ydoc.transact(() => {
      state.yMeta.set('hostId', newHost);
      const cur = state.yMeta.get('currentTurn');
      if (state.yMeta.get('mode') === 'turns' && !isUserPresent(cur)) {
        state.yMeta.set('currentTurn', newHost);
      }
    });
    state.isHost = true;
    showToast('Вы стали хостом', '', 2000);
    refreshHostUI();
  }
}

function isUserPresent(userId) {
  if (userId === state.userId) return true;
  for (const [, a] of state.peerAwareness) if (a.id === userId) return true;
  return false;
}

function onMetaChange() {
  const hostId = state.yMeta.get('hostId');
  state.isHost = hostId === state.userId;
  refreshHostUI();
  updateModeUI();
  // Логический размер холста пришёл от хоста (или изменился) → re-fit.
  const lw = state.yMeta.get('canvasW'), lh = state.yMeta.get('canvasH');
  if (lw && lh && (lw !== state._lastLW || lh !== state._lastLH)) {
    state._lastLW = lw; state._lastLH = lh;
    fitView();
    redrawMain(); redrawOverlay();
  }
}

function refreshHostUI() {
  $('#btn-mode').hidden = !state.isHost;
  $('#btn-clear').disabled = !state.isHost;
  const mode = state.yMeta.get('mode');
  const myTurn = state.yMeta.get('currentTurn') === state.userId;
  $('#btn-next').hidden = !(state.isHost && mode === 'turns' && myTurn);
}

function updateModeUI() {
  const mode = state.yMeta.get('mode') || 'simultaneous';
  const currentTurn = state.yMeta.get('currentTurn');
  const ind = $('#turn-indicator');
  const txt = $('#turn-text');
  ind.classList.remove('waiting', 'you');
  if (mode === 'simultaneous') {
    const online = 1 + state.peers; // вы + пиры
    txt.textContent = 'Рисуем вместе · ' + online + ' онлайн';
    ind.classList.add('you');
    $('#lock-overlay').classList.remove('show');
  } else {
    const myTurn = currentTurn === state.userId;
    const turnPeer = findPeerById(currentTurn);
    const name = turnPeer ? turnPeer.nick : '—';
    if (myTurn) {
      txt.textContent = 'Ваш ход';
      ind.classList.add('you');
      $('#lock-overlay').classList.remove('show');
    } else {
      txt.textContent = 'Ход: ' + name;
      ind.classList.add('waiting');
      $('#lock-overlay').classList.add('show');
    }
  }
  refreshHostUI();
}

function findPeerById(id) {
  if (id === state.userId) {
    return { id, nick: state.nick || ('user-' + state.userId.slice(0, 4)), color: state.userColor };
  }
  for (const [, a] of state.peerAwareness) if (a.id === id) return a;
  return null;
}

// ============ Topbar ============
// Онбординг: разовая карточка «как пользоваться» (один раз на браузер).
const TOUR_STEPS = [
  { sel: '#btn-brushes', title: '1. Кисти', text: '7 умных кистей: акварель, баллончик, царапины, неон. Нажмите здесь, чтобы выбрать.' },
  { sel: '#btn-share', title: '2. Код и QR', text: 'Здесь — код комнаты и QR-код. Отправьте другу, чтобы рисовать вместе или оставить заметку.' },
  { sel: '#stage', title: '3. Бесконечный холст', text: 'Рисуйте где угодно — холст без границ. Два пальца = зум/пан, как в Miro.' },
];
function showOnboarding() {
  try { if (localStorage.getItem('cs_onboarded_v2')) return; } catch(e){}
  const spot = document.createElement('div'); spot.id = 'tour-spot';
  const tip = document.createElement('div'); tip.id = 'tour-tip';
  document.body.appendChild(spot); document.body.appendChild(tip);
  let i = 0;
  const render = () => {
    const step = TOUR_STEPS[i];
    const el = document.querySelector(step.sel);
    if (!el) { i++; if (i < TOUR_STEPS.length) render(); else finish(); return; }
    const r = el.getBoundingClientRect();
    const pad = 6;
    spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
    const above = r.top > window.innerHeight * 0.55;
    tip.innerHTML =
      `<div class="tour-title">${step.title}</div>` +
      `<div class="tour-text">${step.text}</div>` +
      `<div class="tour-nav"><span class="tour-step">${i + 1}/${TOUR_STEPS.length}</span>` +
      `<button class="tour-skip btn btn-ghost">Пропустить</button>` +
      `<button class="tour-next btn btn-primary">${i < TOUR_STEPS.length - 1 ? 'Далее' : 'Готово'}</button></div>`;
    tip.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 272)) + 'px';
    tip.style.top = above ? Math.max(12, r.top - 150) + 'px' : (r.bottom + 12) + 'px';
    tip.querySelector('.tour-next').addEventListener('click', () => { i++; if (i < TOUR_STEPS.length) render(); else finish(); });
    tip.querySelector('.tour-skip').addEventListener('click', finish);
  };
  const finish = () => {
    try { localStorage.setItem('cs_onboarded_v2', '1'); } catch(e){}
    if (spot.parentNode) spot.remove();
    if (tip.parentNode) tip.remove();
  };
  state._onboardDismiss = finish;
  setTimeout(render, 400);   // подождать, пока тулбар отрисуется
}
function setupTopbar() {
  $('#room-badge').addEventListener('click', openShareModal);
  $('#btn-share').addEventListener('click', openShareModal);
  $('#btn-save').addEventListener('click', saveNote);
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#btn-mode').addEventListener('click', toggleMode);
  $('#btn-next').addEventListener('click', passTurn);
}

function toggleMode() {
  if (!state.isHost) return;
  const cur = state.yMeta.get('mode') || 'simultaneous';
  const next = cur === 'simultaneous' ? 'turns' : 'simultaneous';
  state.ydoc.transact(() => {
    state.yMeta.set('mode', next);
    if (next === 'turns') state.yMeta.set('currentTurn', state.userId);
  });
  showToast(next === 'simultaneous' ? 'Режим: одновременно' : 'Режим: по очереди', '', 1500);
}

function passTurn() {
  if (!state.isHost) return;
  const order = state.yMeta.get('turnOrder') || [state.userId];
  const present = order.filter(id => isUserPresent(id));
  if (present.length < 2) { showToast('Нет других игроков', 'error', 1500); return; }
  const cur = state.yMeta.get('currentTurn');
  const idx = present.indexOf(cur);
  const next = present[(idx + 1) % present.length];
  state.yMeta.set('currentTurn', next);
}

function leaveRoom() {
  if (!confirm('Выйти из комнаты? Рисунок останется у других участников.')) return;
  destroyRoom();
  location.hash = '';
  location.reload();
}

function destroyRoom() {
  state.destroyed = true;
  try { if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; } } catch(e){}
  state.reconnecting = false;
  state.hadPeers = false;
  try { window.removeEventListener('beforeunload', flushPersistOnExit); } catch(e){}
  try { if (state.ydoc && state.yStrokes && state.yStrokes.length > 0) {
    const snap = encodeSnapshot();
    if (snap) sbSaveState(state.roomId, snap, { keepalive: true }); // флаш заметки при выходе
  }} catch(e){}
  try { state.yStrokes && state.yStrokes.unobserve(onStrokesChange); } catch(e){}
  try { state.yMeta && state.yMeta.unobserve(onMetaChange); } catch(e){}
  try { state.rtChannel && state.rtChannel.unsubscribe(); } catch(e){}
  try { state.ydoc && state.ydoc.destroy(); } catch(e){}
}

// ============ Участники ============
function updateParticipants() {
  const wrap = $('#participants');
  wrap.innerHTML = '';
  const hostId = state.yMeta && state.yMeta.get('hostId');
  const all = [
    { id: state.userId, nick: state.nick || ('user-' + state.userId.slice(0, 4)), color: state.userColor },
    ...Array.from(state.peerAwareness.values()),
  ];
  const seen = new Set();
  const unique = all.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
  for (const p of unique.slice(0, MAX_PARTICIPANTS)) {
    const av = document.createElement('div');
    av.className = 'avatar' + (p.id === hostId ? ' host' : '');
    av.style.background = p.color;
    av.textContent = (p.nick || '?').slice(0, 1).toUpperCase();
    av.title = p.nick + (p.id === hostId ? ' (хост)' : '');
    wrap.appendChild(av);
  }
  if (unique.length > MAX_PARTICIPANTS) {
    const extra = document.createElement('div');
    extra.className = 'avatar';
    extra.style.background = 'var(--bg-3)';
    extra.style.color = 'var(--text-mute)';
    extra.textContent = '+' + (unique.length - MAX_PARTICIPANTS);
    wrap.appendChild(extra);
  }
}

// ============ Статус подключения ============
function updateConnStatus() {
  const el = $('#conn-status');
  const txt = $('#conn-text');
  el.classList.remove('connecting', 'online', 'error', 'reconnecting');
  if (state.peers === 0) {
    if (state.reconnecting) {
      el.classList.add('reconnecting');
      txt.textContent = 'Переподключение…';
    } else if (state.hadPeers) {
      // пиры были, но не вернулись за 12с — успокаиваем: данные сохранены
      el.classList.add('connecting');
      txt.textContent = 'Один в комнате · рисунок сохранён';
    } else {
      el.classList.add('connecting');
      txt.textContent = 'Один в комнате · рисуйте и отправьте ссылку';
    }
  } else {
    el.classList.add('online');
    txt.textContent = state.peers + (state.peers === 1 ? ' игрок рядом' : ' игрока рядом');
  }
}

// Подсказка на пустом холсте: что делать дальше (особенно когда один).
function updateEmptyHint() {
  const el = document.getElementById('empty-hint');
  if (!el) return;
  const n = state.yStrokes ? state.yStrokes.length : 0;
  el.classList.toggle('show', n === 0);
}

// ============ Холст ============
let dpr = 1;
let canvasW = 0, canvasH = 0;           // размер stage в CSS-пикселях (экран)
// Логический холст: фиксированное координатное пространство, в котором хранятся
// штрихи. Все устройства fit-contain его в свой экран → рисунок с ПК виден на
// телефоне целиком (а не top-left угол). Хост может переопределить размер под
// свой экран (yMeta.canvasW/H) — тогда аспект сохранится.
const LOGICAL_W_DEFAULT = 1280, LOGICAL_H_DEFAULT = 800;
function logicalSize() {
  const w = (state.yMeta && state.yMeta.get('canvasW')) || LOGICAL_W_DEFAULT;
  const h = (state.yMeta && state.yMeta.get('canvasH')) || LOGICAL_H_DEFAULT;
  return { w, h };
}
// view: логические координаты → координаты экрана. screen = logical * scale + offset.
// Холст бесконечный: нет фиксированных границ, рисовать можно где угодно,
// сетка рисуется в канвасе и двигается/масштабируется вместе с контентом.
const view = { scale: 1, ox: 0, oy: 0 };
state.view = view;
const GRID_BASE = 24;            // базовая ячейка сетки в логических px
const MIN_ZOOM = 0.15, MAX_ZOOM = 8;

function fitView() {
  if (canvasW <= 0 || canvasH <= 0) return;
  // Центрируем начало координат (0,0), масштаб — чтобы ~900×600 логики влезало.
  const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(canvasW / 900, canvasH / 600)));
  view.scale = s;
  view.ox = canvasW / 2;
  view.oy = canvasH / 2;
}
// Видимый логический прямоугольник (для сетки/экспорта).
function visibleLogicalRect() {
  const l = (0 - view.ox) / view.scale;
  const t = (0 - view.oy) / view.scale;
  return { l, t, r: (canvasW - view.ox) / view.scale, b: (canvasH - view.oy) / view.scale };
}
// Адаптивная бесконечная сетка: шаг = GRID_BASE * 2^k, чтобы на экране был ~24-96px.
function drawGrid(ctx) {
  const { l, t, r, b } = visibleLogicalRect();
  if (r - l <= 0 || b - t <= 0) return;
  let step = GRID_BASE;
  while (step * view.scale < 24) step *= 2;
  while (step * view.scale > 96) step /= 2;
  const major = step * 5;
  const sl = Math.floor(l / step) * step;
  const st = Math.floor(t / step) * step;
  ctx.save();
  ctx.lineWidth = 1 / view.scale;             // всегда ~1px на экране
  // мелкая сетка
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.beginPath();
  for (let x = sl; x <= r; x += step) { ctx.moveTo(x, t); ctx.lineTo(x, b); }
  for (let y = st; y <= b; y += step) { ctx.moveTo(l, y); ctx.lineTo(r, y); }
  ctx.stroke();
  // крупная сетка (каждая 5-я)
  const sl5 = Math.floor(l / major) * major, st5 = Math.floor(t / major) * major;
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.beginPath();
  for (let x = sl5; x <= r; x += major) { ctx.moveTo(x, t); ctx.lineTo(x, b); }
  for (let y = st5; y <= b; y += major) { ctx.moveTo(l, y); ctx.lineTo(r, y); }
  ctx.stroke();
  // оси (0,0)
  ctx.strokeStyle = 'rgba(0,229,255,0.22)';
  ctx.beginPath(); ctx.moveTo(0, t); ctx.lineTo(0, b); ctx.moveTo(l, 0); ctx.lineTo(r, 0); ctx.stroke();
  ctx.restore();
}
// Bounding box всех штрихов (для экспорта — без пустых полей).
function strokesBBox() {
  const arr = state.yStrokes ? state.yStrokes.toArray() : [];
  if (!arr.length) return { x: -400, y: -300, w: 800, h: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of arr) {
    if (!s.points) continue;
    for (const [px, py] of s.points) {
      if (px < minX) minX = px; if (py < minY) minY = py;
      if (px > maxX) maxX = px; if (py > maxY) maxY = py;
    }
  }
  if (!isFinite(minX)) return { x: -400, y: -300, w: 800, h: 600 };
  const pad = 32;
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}
// Применить view-трансформ к контексту (для отрисовки штрихов в логических коорд.)
function applyView(ctx) {
  ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.ox * dpr, view.oy * dpr);
}
// Zoom вокруг точки экрана (sx,sy) с учётом dpi-экрана.
function zoomAt(sx, sy, factor) {
  const lx = (sx - view.ox) / view.scale;
  const ly = (sy - view.oy) / view.scale;
  const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.scale * factor));
  view.scale = newScale;
  view.ox = sx - lx * newScale;
  view.oy = sy - ly * newScale;
  redrawMain(); redrawOverlay();
}

function initCanvas() {
  onResize();
  liveCanvas.style.pointerEvents = 'none';
  mainCanvas.style.pointerEvents = 'none';
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointerleave', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  // Wheel-zoom (десктоп): колесо = зум вокруг курсора. Ctrl+колесо тоже зум.
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const [sx, sy] = screenCoord(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(sx, sy, factor);
  }, { passive: false });
  stage.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  stage.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  stage.style.touchAction = 'none';
  redrawMain();
  redrawOverlay();
}

function onResize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = stage.getBoundingClientRect();
  canvasW = rect.width;
  canvasH = rect.height;
  for (const c of [mainCanvas, liveCanvas]) {
    c.width = Math.floor(canvasW * dpr);
    c.height = Math.floor(canvasH * dpr);
    c.style.width = canvasW + 'px';
    c.style.height = canvasH + 'px';
  }
  // Хост один раз фиксирует логический размер под свой экран (aspect сохранится
  // для joiner'ов). Не-хост читает canvasW/H из yMeta (через Realtime).
  if (state.isHost && state.yMeta && !state.yMeta.get('canvasW') && canvasW > 0) {
    state.yMeta.set('canvasW', Math.round(canvasW));
    state.yMeta.set('canvasH', Math.round(canvasH));
  }
  fitView();
  redrawMain();
  redrawOverlay();
}

function pointerCoord(e) {
  const rect = stage.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  // экранные → логические (инверсия view-трансформ)
  return [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];
}
// логические → экранные (для позиционирования DOM-элементов, напр. текст-input)
function logicalToScreen(lx, ly) {
  return [lx * view.scale + view.ox, ly * view.scale + view.oy];
}

function canDrawNow() {
  const mode = state.yMeta.get('mode') || 'simultaneous';
  if (mode === 'simultaneous') return true;
  return state.yMeta.get('currentTurn') === state.userId;
}

// ============ Рисование + pan/zoom ============
// Активные указатели для multi-touch (pinch-zoom / two-finger pan).
const pointers = new Map();          // pointerId → {sx, sy} (экранные coords)
let pinch = null;                    // {dist0, midSx0, midSy0, scale0, ox0, oy0}
let pan = null;                      // {sx0, sy0, ox0, oy0} для hand-инструмента

function screenCoord(e) {
  const rect = stage.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function startPinch() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const [a, b] = pts;
  const dx = b.sx - a.sx, dy = b.sy - a.sy;
  pinch = {
    dist0: Math.hypot(dx, dy) || 1,
    midSx0: (a.sx + b.sx) / 2,
    midSy0: (a.sy + b.sy) / 2,
    scale0: view.scale,
    ox0: view.ox,
    oy0: view.oy,
  };
  // Прерываем текущее рисование ( второй палец = жест навигации, не штрих)
  if (state.isDrawing) {
    state.isDrawing = false;
    state.currentStroke = null;
    pushAwareness();
    redrawOverlay();
  }
}
function updatePinch() {
  if (!pinch) return;
  const pts = [...pointers.values()];
  if (pts.length < 2) { pinch = null; return; }
  const [a, b] = pts;
  const dist = Math.hypot(b.sx - a.sx, b.sy - a.sy) || 1;
  const midSx = (a.sx + b.sx) / 2, midSy = (a.sy + b.sy) / 2;
  // Логическая точка под начальным центром — должна оставаться под новым центром.
  const lx = (pinch.midSx0 - pinch.ox0) / pinch.scale0;
  const ly = (pinch.midSy0 - pinch.oy0) / pinch.scale0;
  const newScale = Math.max(0.1, Math.min(8, pinch.scale0 * (dist / pinch.dist0)));
  view.scale = newScale;
  // Сдвиг: новый центр + pan-дельта (mid переместился)
  view.ox = midSx - lx * newScale + (midSx - pinch.midSx0);
  view.oy = midSy - ly * newScale + (midSy - pinch.midSy0);
  redrawMain(); redrawOverlay();
}

function onPointerDown(e) {
  if (state.destroyed) return;
  if (state._onboardDismiss) state._onboardDismiss();   // тур уходит, когда начали рисовать
  const [sx, sy] = screenCoord(e);
  pointers.set(e.pointerId, { sx, sy });
  // Второй палец → pinch-zoom/pan (навигация), рисование прерывается.
  if (pointers.size >= 2) { startPinch(); return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  // Hand-инструмент: один палец/мышь = pan.
  if (state.tool === 'hand') {
    pan = { sx0: sx, sy0: sy, ox0: view.ox, oy0: view.oy };
    try { stage.setPointerCapture(e.pointerId); } catch(_) {}
    return;
  }
  if (!canDrawNow()) { showToast('Не ваш ход', 'error', 1200); return; }

  const [x, y] = pointerCoord(e);
  state._cursor = [x, y];

  if (state.tool === 'text') {
    spawnTextInput(x, y);
    return;
  }
  if (state.tool === 'sticky') {
    const hitId = stickyHit(x, y);
    if (hitId) {                                   // тянем существующую заметку
      const s = allStickies().find(st => st.id === hitId);
      const [sx, sy] = s.points[0];
      state._stickyDrag = { id: hitId, offX: x - sx, offY: y - sy, cur: [sx, sy] };
      state._selSticky = hitId;
      try { stage.setPointerCapture(e.pointerId); } catch(_) {}
      redrawMain();
    } else {                                       // новая заметка
      state._selSticky = null; redrawMain();
      spawnStickyInput(x, y);
    }
    return;
  }

  state.isDrawing = true;
  state.redoStack = [];
  // Фигуры хранят [start, end]; кисти — массив точек пути.
  const pts = SHAPES.has(state.tool) ? [[x, y], [x, y]] : [[x, y]];
  state.currentStroke = {
    id: uuid(),
    tool: state.tool,
    color: state.color,
    size: state.size,
    layer: state.layer,
    author: state.userId,
    authorColor: state.userColor,
    points: pts,
    ts: Date.now(),
  };
  try { stage.setPointerCapture(e.pointerId); } catch(_) {}
  pushAwareness();
  redrawOverlay();
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId) && e.pointerType !== 'mouse') return;
  const [sx, sy] = screenCoord(e);
  pointers.set(e.pointerId, { sx, sy });

  if (pinch) { updatePinch(); return; }
  if (pan) {
    view.ox = pan.ox0 + (sx - pan.sx0);
    view.oy = pan.oy0 + (sy - pan.sy0);
    redrawMain(); redrawOverlay();
    return;
  }
  if (state._stickyDrag) {
    const [x, y] = pointerCoord(e);
    state._stickyDrag.cur = [x - state._stickyDrag.offX, y - state._stickyDrag.offY];
    redrawMain();
    return;
  }
  const [x, y] = pointerCoord(e);
  state._cursor = [x, y];
  if (state.isDrawing && state.currentStroke) {
    const cs = state.currentStroke;
    if (SHAPES.has(cs.tool)) {
      cs.points[1] = [x, y];                 // фигура: тянем второй угол
      pushCursorAwareness();
      redrawOverlay();
    } else {
      const pts = cs.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) > 1.2 / view.scale) {
        pts.push([x, y]);
        pushCursorAwareness();
        redrawOverlay();
      }
    }
  } else {
    pushCursorAwareness();
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pan) {
    try { stage.releasePointerCapture(e.pointerId); } catch(_) {}
    pan = null;
    return;
  }
  if (state._stickyDrag) {
    try { stage.releasePointerCapture(e.pointerId); } catch(_) {}
    const d = state._stickyDrag; state._stickyDrag = null;
    commitStickyUpdate(d.id, { points: [d.cur] });
    redrawMain();
    return;
  }
  if (pinch && pointers.size < 2) { pinch = null; }
  if (!state.isDrawing) return;
  try { stage.releasePointerCapture(e.pointerId); } catch(_) {}
  const stroke = state.currentStroke;
  state.isDrawing = false;
  state.currentStroke = null;

  if (stroke && stroke.points.length > 0) {
    state.yStrokes.push([stroke]);
    state.undoStack.push(stroke.id);
    updateUndoRedoUI();
  }
  pushAwareness();
  redrawOverlay();
}

// ============ Текстовый инструмент ============
function spawnTextInput(x, y) {
  const old = stage.querySelector('.text-input');
  if (old) old.remove();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input';
  input.placeholder = 'Текст…';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('enterkeyhint', 'done');
  // x,y — логические координаты. DOM позиционируется в экранном пространстве stage.
  const [sx, sy] = logicalToScreen(x, y);
  input.style.left = sx + 'px';
  input.style.top = (sy - 14 * view.scale) + 'px';
  const fontSize = clamp(state.size * 3, 14, 72) * view.scale;
  input.style.fontSize = Math.max(13, fontSize) + 'px';
  input.style.color = state.color;
  input.style.borderColor = state.color;
  stage.appendChild(input);
  // ВАЖНО: focus() синхронно, в обработчике тапа — иначе iOS не откроет клавиатуру.
  // setTimeout рвал user-gesture chain; теперь вызываем сразу после вставки в DOM.
  try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const text = input.value.trim();
    // Убираем обработчики перед remove, чтобы blur не вызвал повторный commit
    input.onblur = null;
    input.remove();
    if (!text) return;
    const stroke = {
      id: uuid(),
      tool: 'text',
      color: state.color,
      size: state.size,
      layer: state.layer,
      author: state.userId,
      authorColor: state.userColor,
      points: [[x, y]],
      text,
      ts: Date.now(),
    };
    state.yStrokes.push([stroke]);
    state.undoStack.push(stroke.id);
    updateUndoRedoUI();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') input.remove();
  });
  input.addEventListener('blur', commit);
}

// ============ Липкие заметки: ввод текста ============
function spawnStickyInput(x, y, existing) {
  const old = stage.querySelector('.sticky-input');
  if (old) old.remove();
  const ta = document.createElement('textarea');
  ta.className = 'sticky-input';
  ta.placeholder = 'Заметка…';
  ta.setAttribute('autocomplete', 'off');
  const [sx, sy] = logicalToScreen(x, y);
  const w = STICKY_W * view.scale, h = STICKY_H * view.scale;
  const bg = existing ? existing.color : stickyColor(allStickies().length);
  ta.style.left = sx + 'px'; ta.style.top = sy + 'px';
  ta.style.width = w + 'px'; ta.style.height = h + 'px';
  ta.style.fontSize = Math.max(13, 15 * view.scale) + 'px';
  ta.style.background = bg; ta.style.color = '#1a1f2b';
  ta.style.transformOrigin = 'top left';
  stage.appendChild(ta);
  if (existing && existing.text) ta.value = existing.text;
  try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }

  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const text = ta.value.trim();
    ta.onblur = null; ta.remove();
    if (existing) {
      if (text) commitStickyUpdate(existing.id, { text });
      else deleteSticky(existing.id);              // пустая заметка при редакте → удалить
    } else if (text) {
      const stroke = {
        id: uuid(), tool: 'sticky', color: bg, size: 5, layer: state.layer,
        author: state.userId, authorColor: state.userColor,
        points: [[x, y]], text, w: STICKY_W, h: STICKY_H, ts: Date.now(),
      };
      state.yStrokes.push([stroke]);
      state.undoStack.push(stroke.id);
      updateUndoRedoUI();
    }
    redrawMain();
  };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; ta.remove(); }
  });
  ta.addEventListener('blur', commit);
}
// Двойной тап/клик по заметке → редактировать текст.
function setupStickyEdit() {
  stage.addEventListener('dblclick', e => {
    const [x, y] = pointerCoord(e);
    const id = stickyHit(x, y);
    if (!id) return;
    const s = allStickies().find(st => st.id === id);
    if (s) spawnStickyInput(s.points[0][0], s.points[0][1], s);
  });
  // Delete/Backspace удаляет выбранную заметку (не в текстовом поле).
  document.addEventListener('keydown', e => {
    if (state._selSticky && (e.key === 'Delete' || e.key === 'Backspace')) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      deleteSticky(state._selSticky);
    }
  });
}

// ============ Отрисовка ============
function onStrokesChange() {
  redrawMain(); schedulePersist(); updateEmptyHint();
  markDirty();   // индикатор: есть несохранённые изменения
  if (state._onboardDismiss) state._onboardDismiss(); // первый штрих → скрыть онбординг
}

function redrawMain() {
  if (state.destroyed) return;
  mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mainCtx.clearRect(0, 0, canvasW, canvasH);
  applyView(mainCtx);
  drawGrid(mainCtx);
  const arr = state.yStrokes.toArray();
  arr.sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  for (const s of arr) drawStroke(mainCtx, s);
}

function redrawOverlay() {
  if (state.destroyed) return;
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  liveCtx.clearRect(0, 0, canvasW, canvasH);
  applyView(liveCtx);
  if (state.isDrawing && state.currentStroke) {
    drawStroke(liveCtx, state.currentStroke);
  }
  for (const [, a] of state.peerAwareness) {
    if (a.drawing && a.liveStroke) {
      drawStroke(liveCtx, a.liveStroke, a.color);
    }
  }
  for (const [, a] of state.peerAwareness) {
    if (a.cursor) {
      drawCursor(liveCtx, a.cursor[0], a.cursor[1], a.color, a.nick, a.drawing);
    }
  }
}

// ============ Кисти и фигуры ============
// Все кисти детерминированы точками штриха → на любом устройстве рисуются одинаково
// (важно для sync). Скорость/плотность выводятся из расстояния между точками.
const SHAPES = new Set(['line', 'rect', 'ellipse']);
const BRUSHES = ['pen', 'pencil', 'marker', 'watercolor', 'spray', 'scratch', 'neon'];

function hexA(hex, a) {
  const c = (hex || '#000').replace('#', '');
  const r = parseInt(c.substr(0, 2), 16) || 0;
  const g = parseInt(c.substr(2, 2), 16) || 0;
  const b = parseInt(c.substr(4, 2), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}
// Детерминированный PRNG (одинаково на всех устройствах → синхронный спрей/царапины).
function makeRng(seed) { let s = (seed | 0) || 1; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 100000) / 100000; }; }
function seedFrom(pts) { let h = 2166136261 >>> 0; for (const p of pts) { h = Math.imul(h ^ Math.round(p[0] * 10), 16777619); h = Math.imul(h ^ Math.round(p[1] * 10), 16777619); } return h >>> 0; }
// Сглаженный путь (квадратичные кривые по серединам) — для pen/pencil/marker/watercolor/neon.
function strokePath(ctx, pts) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

function brushPen(ctx, s) {
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  strokePath(ctx, s.points);
}
// Карандаш: полупрозрачная линия + зернистая текстура вокруг пути.
function brushPencil(ctx, s) {
  const rng = makeRng(seedFrom(s.points));
  ctx.strokeStyle = hexA(s.color, 0.55); ctx.lineWidth = Math.max(0.6, s.size * 0.8);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  strokePath(ctx, s.points);
  ctx.fillStyle = hexA(s.color, 0.28);
  for (let i = 0; i < s.points.length; i++) {
    const [x, y] = s.points[i];
    const n = Math.ceil(s.size * 0.6);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2, r = rng() * s.size * 0.55;
      ctx.fillRect(x + Math.cos(a) * r, y + Math.sin(a) * r, 0.7, 0.7);
    }
  }
}
// Маркер/текстовыделитель: плоский полупрозрачный широкий штрих.
function brushMarker(ctx, s) {
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size * 1.7;
  ctx.lineCap = 'square'; ctx.lineJoin = 'round';
  strokePath(ctx, s.points);
  ctx.globalAlpha = 1;
}
// Акварель: мягкие слои (широкий прозрачный → узкий насыщенный) + лёгкое размытие края.
function brushWatercolor(ctx, s) {
  ctx.strokeStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = hexA(s.color, 0.5); ctx.shadowBlur = s.size * 0.8;
  const layers = [[s.size * 2.1, 0.05], [s.size * 1.5, 0.09], [s.size * 1.0, 0.14], [s.size * 0.55, 0.22]];
  for (const [w, a] of layers) { ctx.globalAlpha = a; ctx.lineWidth = w; strokePath(ctx, s.points); }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
// Баллончик: распыление частиц вдоль пути. Плотность = чаще сэмплы где ведёшь медленно.
function brushSpray(ctx, s) {
  const rng = makeRng(seedFrom(s.points));
  const R = Math.max(2, s.size * 1.4);
  ctx.fillStyle = hexA(s.color, 0.45);
  const pts = s.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.floor(seg / (R * 0.28)));
    for (let t = 0; t < steps; t++) {
      const cx = x0 + (x1 - x0) * (t / steps), cy = y0 + (y1 - y0) * (t / steps);
      const dots = Math.ceil(R * 1.1);
      for (let k = 0; k < dots; k++) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * R;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.max(0.4, rng() * 0.9 + 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
// Царапины: длинные сегменты (быстрое движение) → короткие рваные штрихи поперёк движения.
function brushScratch(ctx, s) {
  const rng = makeRng(seedFrom(s.points));
  const pts = s.points;
  ctx.strokeStyle = hexA(s.color, 0.85); ctx.lineWidth = Math.max(0.6, s.size * 0.5); ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1.5) continue;
    const nx = -dy / len, ny = dx / len;             // нормаль к направлению
    const scratches = Math.max(1, Math.floor(len / Math.max(2, s.size * 0.6)));
    for (let k = 0; k < scratches; k++) {
      const f = (k + 0.5) / scratches;
      const cx = x0 + dx * f, cy = y0 + dy * f;
      const half = rng() * s.size * 0.7 + s.size * 0.2;
      const off = (rng() - 0.5) * s.size * 0.4;
      const dir = rng() > 0.5 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx + nx * off, cy + ny * off);
      ctx.lineTo(cx + nx * (off + dir * half), cy + ny * (off + dir * half));
      ctx.stroke();
    }
  }
}
// Неон: светящаяся обводка (shadowBlur) + яркое ядро.
function brushNeon(ctx, s) {
  ctx.shadowColor = s.color; ctx.shadowBlur = s.size * 2.4;
  ctx.strokeStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.55; ctx.lineWidth = s.size * 1.5; strokePath(ctx, s.points);
  ctx.globalAlpha = 1; ctx.lineWidth = Math.max(0.8, s.size * 0.5); ctx.strokeStyle = '#ffffff';
  strokePath(ctx, s.points);
  ctx.shadowBlur = 0;
}
// Фигуры: points = [start, end].
function shapeLine(ctx, s) {
  const [a, b] = s.points;
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}
function shapeRect(ctx, s) {
  const [a, b] = s.points;
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineJoin = 'round';
  ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
}
function shapeEllipse(ctx, s) {
  const [a, b] = s.points;
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.max(0.5, Math.abs(b[0] - a[0]) / 2), ry = Math.max(0.5, Math.abs(b[1] - a[1]) / 2);
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
}

// ============ Липкие заметки (sticky notes) ============
const STICKY_W = 190, STICKY_H = 130, STICKY_PAD = 10;
const STICKY_COLORS = ['#ffe27a', '#ffd0e0', '#b6f5c0', '#bcd9ff', '#f0c9ff', '#ffd9a8'];
function stickyColor(i) { return STICKY_COLORS[i % STICKY_COLORS.length]; }
function allStickies() {
  return (state.yStrokes ? state.yStrokes.toArray() : []).filter(s => s.tool === 'sticky');
}
function findStickyIndex(id) {
  if (!state.yStrokes) return -1;
  for (let i = 0; i < state.yStrokes.length; i++) if (state.yStrokes.get(i).id === id) return i;
  return -1;
}
// Попадание точки в sticky (топ-последний выигрывает). Возвращает id или null.
function stickyHit(x, y) {
  const arr = allStickies();
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i], [sx, sy] = s.points[0];
    const w = s.w || STICKY_W, h = s.h || STICKY_H;
    if (x >= sx && x <= sx + w && y >= sy && y <= sy + h) return s.id;
  }
  return null;
}
function wrapText(ctx, text, maxW) {
  const words = (text || '').split(/\s+/);
  const lines = []; let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
function drawSticky(ctx, s) {
  const [x0, y0] = s.points[0];
  const drag = state._stickyDrag && state._stickyDrag.id === s.id ? state._stickyDrag.cur : null;
  const x = drag ? drag[0] : x0, y = drag ? drag[1] : y0;
  const w = s.w || STICKY_W, h = s.h || STICKY_H;
  const bg = s.color || STICKY_COLORS[0];
  ctx.save();
  // мягкая тень
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 12 / view.scale; ctx.shadowOffsetY = 4 / view.scale;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, h, 6 / view.scale + 4); ctx.fill();
  ctx.shadowColor = 'transparent';
  // загнутый уголок
  ctx.fillStyle = 'rgba(0,0,0,.10)';
  ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w - 14, y); ctx.lineTo(x + w, y + 14); ctx.closePath(); ctx.fill();
  // текст
  const fs = 15;
  ctx.fillStyle = '#1a1f2b'; ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`; ctx.textBaseline = 'top';
  ctx.beginPath(); roundRect(ctx, x + STICKY_PAD, y + STICKY_PAD, w - STICKY_PAD * 2, h - STICKY_PAD * 2, 3); ctx.clip();
  const lines = wrapText(ctx, s.text || '', w - STICKY_PAD * 2);
  let ty = y + STICKY_PAD;
  for (const ln of lines) { ctx.fillText(ln, x + STICKY_PAD, ty); ty += fs + 3; if (ty > y + h - STICKY_PAD) break; }
  // выделение (выбрано для перемещения)
  if (state._selSticky === s.id) {
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2 / view.scale;
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 8); ctx.stroke();
  }
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// Применить перемещение/текст к существующей заметке (delete+insert в yStrokes).
function commitStickyUpdate(id, patch) {
  const i = findStickyIndex(id);
  if (i < 0) return;
  const s = state.yStrokes.get(i);
  const upd = Object.assign({}, s, patch);
  state.ydoc.transact(() => {
    state.yStrokes.delete(i, 1);
    state.yStrokes.insert(i, [upd]);
  }, 'sticky-edit');
}
function deleteSticky(id) {
  const i = findStickyIndex(id);
  if (i < 0) return;
  state.yStrokes.delete(i, 1);
  if (state._selSticky === id) state._selSticky = null;
  redrawMain();
}

function drawStroke(ctx, s, overrideColor) {
  if (!s || !s.points || s.points.length === 0) return;
  ctx.save();
  const color = overrideColor || s.color;
  const st = overrideColor ? Object.assign({}, s, { color }) : s;
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    strokePath(ctx, s.points);
    if (s.points.length === 1) { ctx.beginPath(); ctx.arc(s.points[0][0], s.points[0][1], Math.max(0.5, s.size / 2), 0, Math.PI * 2); ctx.fill(); }
  } else if (s.tool === 'text' && s.text) {
    const fontSize = clamp(s.size * 3, 14, 72);
    ctx.fillStyle = color; ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, s.points[0][0], s.points[0][1]);
  } else if (s.tool === 'sticky') {
    drawSticky(ctx, s);
  } else {
    switch (s.tool) {
      case 'pen': brushPen(ctx, st); break;
      case 'pencil': brushPencil(ctx, st); break;
      case 'marker': brushMarker(ctx, st); break;
      case 'watercolor': brushWatercolor(ctx, st); break;
      case 'spray': brushSpray(ctx, st); break;
      case 'scratch': brushScratch(ctx, st); break;
      case 'neon': brushNeon(ctx, st); break;
      case 'line': shapeLine(ctx, st); break;
      case 'rect': shapeRect(ctx, st); break;
      case 'ellipse': shapeEllipse(ctx, st); break;
      default: brushPen(ctx, st);
    }
  }
  ctx.restore();
}

function drawCursor(ctx, x, y, color, nick, drawing) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, drawing ? 6 : 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (nick) {
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const label = nick.slice(0, 14);
    const w = ctx.measureText(label).width + 10;
    const { w: lw } = logicalSize();
    let lx = x + 10, ly = y - 18;
    if (lx + w > lw) lx = x - w - 10;
    if (ly < 4) ly = y + 14;
    ctx.fillStyle = 'rgba(10,13,18,.78)';
    ctx.fillRect(lx, ly, w, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, lx + 5, ly + 13);
  }
  ctx.restore();
}

// ============ Установка PWA на главный экран ============
function setupInstall() {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const modal = $('#install-modal');
  const steps = $('#install-steps');
  const btnIos = $('#btn-install-ios');
  const btnOther = $('#btn-install-other');
  if (!modal || isStandalone) return;
  let deferredPrompt = null;

  const renderSteps = kind => {
    if (kind === 'ios') {
      steps.innerHTML =
        '<div class="step"><span class="n">1</span><span class="t">Откройте эту страницу в <b>Safari</b> — установка работает только из Safari, не из Chrome.</span></div>' +
        '<div class="step"><span class="n">2</span><span class="t">Нажмите <b>«Поделиться»</b> внизу — квадрат со стрелкой вверх ▭↗.</span></div>' +
        '<div class="step"><span class="n">3</span><span class="t">Прокрутите вниз и выберите <b>«На экран Домой»</b> (Add to Home Screen).</span></div>' +
        '<div class="step"><span class="n">4</span><span class="t">Нажмите <b>«Добавить»</b> — иконка появится на главном экране. Запускайте как обычное приложение, оффлайн-оболочка уже внутри.</span></div>';
    } else {
      steps.innerHTML =
        '<div class="step"><span class="n">1</span><span class="t">Нажмите <b>«Установить приложение»</b> в подсказке браузера или в меню (⋮) → Установить.</span></div>' +
        '<div class="step"><span class="n">2</span><span class="t">Подтвердите — иконка появится на главном экране.</span></div>';
    }
  };

  if (isIOS) {
    btnIos.hidden = false;
    btnIos.addEventListener('click', () => { renderSteps('ios'); modal.classList.add('show'); });
  } else {
    btnOther.hidden = false;
    btnOther.addEventListener('click', e => {
      e.preventDefault();
      if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice?.catch(() => {}); }
      else { renderSteps('other'); modal.classList.add('show'); }
    });
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });
  }
  $('#install-close').addEventListener('click', () => modal.classList.remove('show'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
}

// ============ Тулбар ============
const BRUSH_INFO = {
  pen:        { name: 'Перо',      icon: '✏️' },
  pencil:     { name: 'Карандаш',  icon: '✎' },
  marker:     { name: 'Маркер',    icon: '🖊️' },
  watercolor: { name: 'Акварель',  icon: '🎨' },
  spray:      { name: 'Баллончик', icon: '🌫️' },
  scratch:    { name: 'Царапины',  icon: '✸' },
  neon:       { name: 'Неон',      icon: '✨' },
  line:       { name: 'Линия',     icon: '╱' },
  rect:       { name: 'Прямоуг.',  icon: '▭' },
  ellipse:    { name: 'Эллипс',    icon: '◯' },
  eraser:     { name: 'Ластик',    icon: '🧽' },
  text:       { name: 'Текст',     icon: '🔤' },
  hand:       { name: 'Рука',      icon: '✋' },
};
function selectTool(tool) {
  state.tool = tool;
  if (state._selSticky) { state._selSticky = null; redrawMain(); }
  // быстрое переключение для кистей/фигур
  $$('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $$('.palette-item').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const info = BRUSH_INFO[tool];
  const trig = $('#btn-brushes');
  if (trig && info) {
    $('#brush-icon').textContent = info.icon;
    const nm = $('#brush-name'); if (nm) nm.textContent = info.name;
    trig.classList.toggle('active', BRUSHES.includes(tool) || SHAPES.has(tool));
  }
}
function setupToolbar() {
  // Быстрые кнопки: ластик / текст / рука.
  $$('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => selectTool(btn.dataset.tool));
  });
  // Палитра кистей/фигур.
  const trig = $('#btn-brushes');
  const palette = $('#brush-palette');
  if (trig && palette) {
    trig.addEventListener('click', e => {
      e.stopPropagation();
      const open = palette.classList.toggle('show');
      trig.classList.toggle('open', open);
    });
    $$('.palette-item').forEach(item => {
      item.addEventListener('click', () => {
        selectTool(item.dataset.tool);
        palette.classList.remove('show');
        trig.classList.remove('open');
      });
    });
    document.addEventListener('click', e => {
      if (!palette.contains(e.target) && e.target !== trig && !trig.contains(e.target)) {
        palette.classList.remove('show'); trig.classList.remove('open');
      }
    });
  }
  // Zoom-контрол: Fit (вписать), +/- вокруг центра экрана.
  const zIn = $('#btn-zoom-in'), zOut = $('#btn-zoom-out'), zFit = $('#btn-fit');
  if (zIn) zIn.addEventListener('click', () => zoomAt(canvasW / 2, canvasH / 2, 1.2));
  if (zOut) zOut.addEventListener('click', () => zoomAt(canvasW / 2, canvasH / 2, 1 / 1.2));
  if (zFit) zFit.addEventListener('click', () => { fitView(); redrawMain(); redrawOverlay(); });
  $('#color-input').addEventListener('input', e => {
    state.color = e.target.value;
    syncSwatchActive();
  });
  const range = $('#size-range');
  const dot = $('#size-dot');
  range.addEventListener('input', e => {
    state.size = parseInt(e.target.value, 10);
    const v = clamp(state.size, 3, 24);
    dot.style.width = v + 'px';
    dot.style.height = v + 'px';
  });
  $('#layer-select').addEventListener('change', e => {
    state.layer = parseInt(e.target.value, 10);
  });
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-clear').addEventListener('click', clearCanvas);
  $('#btn-download').addEventListener('click', downloadPNG);
  $('#btn-svg').addEventListener('click', downloadSVG);
  $('#btn-pdf').addEventListener('click', downloadPDF);
  // «⋯ Ещё» — поповер с редкими действиями (undo/redo/download/clear/слой)
  const moreMenu = $('#more-menu');
  const moreBtn = $('#btn-more');
  if (moreMenu && moreBtn) {
    moreBtn.addEventListener('click', e => { e.stopPropagation(); moreMenu.classList.toggle('show'); });
    document.addEventListener('pointerdown', e => {
      if (!moreMenu.contains(e.target) && e.target !== moreBtn) moreMenu.classList.remove('show');
    });
    // Действия внутри меню закрывают его
    moreMenu.querySelectorAll('button, select').forEach(el =>
      el.addEventListener('pointerdown', () => { setTimeout(() => moreMenu.classList.remove('show'), 60); }));
  }
}

function buildSwatches() {
  const wrap = $('#swatches');
  wrap.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.style.color = c;
    b.dataset.color = c;
    b.title = c;
    if (c === state.color) b.classList.add('active');
    b.addEventListener('click', () => {
      state.color = c;
      $('#color-input').value = c;
      syncSwatchActive();
    });
    wrap.appendChild(b);
  }
}

function syncSwatchActive() {
  $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.color === state.color));
}

function updateUndoRedoUI() {
  $('#btn-undo').disabled = state.undoStack.length === 0;
  $('#btn-redo').disabled = state.redoStack.length === 0;
}

// ============ Undo / Redo / Clear ============
function undo() {
  if (state.undoStack.length === 0) return;
  const id = state.undoStack.pop();
  const arr = state.yStrokes.toArray();
  let idx = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].id === id) { idx = i; break; }
  }
  if (idx === -1) { updateUndoRedoUI(); return; }
  const removed = arr[idx];
  state.ydoc.transact(() => { state.yStrokes.delete(idx, 1); });
  state.redoStack.push(removed);
  updateUndoRedoUI();
}

function redo() {
  if (state.redoStack.length === 0) return;
  const stroke = state.redoStack.pop();
  stroke.id = uuid();
  state.yStrokes.push([stroke]);
  state.undoStack.push(stroke.id);
  updateUndoRedoUI();
}

function clearCanvas() {
  if (!state.isHost) { showToast('Только хост может очистить холст', 'error'); return; }
  if (!confirm('Очистить холст для всех участников?')) return;
  state.ydoc.transact(() => {
    state.yStrokes.delete(0, state.yStrokes.length);
  });
  state.undoStack = [];
  state.redoStack = [];
  updateUndoRedoUI();
  showToast('Холст очищен', 'success', 1500);
}

function downloadPNG() {
  // Экспорт по bounding box всех штрихов (без пустых полей, бесконечный холст).
  const bb = strokesBBox();
  const scale = 2;                         // 2× для чёткости
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bb.w * scale));
  out.height = Math.max(1, Math.round(bb.h * scale));
  const octx = out.getContext('2d');
  octx.fillStyle = '#11161f';
  octx.fillRect(0, 0, out.width, out.height);
  octx.setTransform(scale, 0, 0, scale, -bb.x * scale, -bb.y * scale);
  const arr = (state.yStrokes ? state.yStrokes.toArray() : []).slice();
  arr.sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  for (const s of arr) drawStroke(octx, s);
  const link = document.createElement('a');
  link.download = `catscribbles-${state.roomCode}-${Date.now()}.png`;
  link.href = out.toDataURL('image/png');
  link.click();
  showToast('Скачано', 'success', 1200);
}
// Экспорт векторного SVG: pen-штрихи → <path> (квадратичные кривые), text → <text>.
// Ластик пропускается (в векторе он не имеет смысла; для точного растра есть PNG).
function strokeToPath(s) {
  const p = s.points;
  if (!p || p.length === 0) return '';
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]} l0.01 0`;
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x, y] = p[i], [nx, ny] = p[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = p[p.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}
function downloadSVG() {
  const bb = strokesBBox();
  const arr = (state.yStrokes ? state.yStrokes.toArray() : []).slice();
  arr.sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  let body = '', skipped = 0;
  for (const s of arr) {
    if (s.tool === 'eraser') continue;
    const esc = t => String(t).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    if (s.tool === 'text' && s.text) {
      const fs = Math.max(14, Math.min(72, (s.size || 4) * 3));
      body += `  <text x="${s.points[0][0]}" y="${s.points[0][1]}" font-family="Inter,system-ui,sans-serif" font-weight="600" font-size="${fs}" fill="${s.color}" dominant-baseline="middle">${esc(s.text)}</text>\n`;
    } else if (SHAPES.has(s.tool)) {
      const [a, b] = s.points;
      const sw = s.size, col = s.color;
      if (s.tool === 'line') body += `  <line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>\n`;
      else if (s.tool === 'rect') body += `  <rect x="${Math.min(a[0],b[0])}" y="${Math.min(a[1],b[1])}" width="${Math.abs(b[0]-a[0])}" height="${Math.abs(b[1]-a[1])}" stroke="${col}" stroke-width="${sw}" fill="none" stroke-linejoin="round"/>\n`;
      else { const cx=(a[0]+b[0])/2, cy=(a[1]+b[1])/2, rx=Math.abs(b[0]-a[0])/2, ry=Math.abs(b[1]-a[1])/2; body += `  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="${col}" stroke-width="${sw}" fill="none"/>\n`; }
    } else if (s.tool === 'pen' || s.tool === 'pencil' || s.tool === 'marker' || s.tool === 'watercolor' || s.tool === 'neon') {
      const d = strokeToPath(s);
      if (!d) continue;
      let w = s.size, op = 1, extra = '';
      if (s.tool === 'pencil') { w = s.size * 0.8; op = 0.55; }
      else if (s.tool === 'marker') { w = s.size * 1.7; op = 0.35; extra = ' stroke-linecap="square"'; }
      else if (s.tool === 'watercolor') { w = s.size * 1.3; op = 0.18; }
      else if (s.tool === 'neon') { extra = ` filter="url(#neon)"`; }
      body += `  <path d="${d}" stroke="${s.color}" stroke-width="${w}" fill="none" opacity="${op}" stroke-linecap="round" stroke-linejoin="round"${extra}/>\n`;
    } else {
      skipped++;   // spray/scratch — растровые, в SVG не выгружаются (есть PNG)
    }
  }
  if (!body) { showToast('Пусто — нечего выгружать', '', 1600); return; }
  const defs = body.includes('url(#neon)') ? `  <defs><filter id="neon" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.round((state.size||4)*1.2)}"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>\n` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bb.x} ${bb.y} ${bb.w} ${bb.h}" width="${Math.round(bb.w)}" height="${Math.round(bb.h)}">\n` +
    `  <rect x="${bb.x}" y="${bb.y}" width="${bb.w}" height="${bb.h}" fill="#11161f"/>\n` + defs + body + `</svg>`;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `catscribbles-${state.roomCode}-${Date.now()}.svg`;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(skipped > 0 ? `SVG скачан (${skipped} растровых кистей пропущено — используйте PNG)` : 'SVG скачан', 'success', 1800);
}

// ============ Шаблоны холста ============
function circlePts(cx, cy, r, n = 28) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  p.push(p[0]);
  return p;
}
function mkStroke(tool, points, color, size, layer = 0) {
  return { id: uuid(), tool, color, size, layer, author: state.userId, authorColor: state.userColor, points, ts: Date.now() };
}
// Каждый шаблон возвращает массив штрихов в логических координатах (центр в 0,0).
const TEMPLATES = {
  grid: () => {           // миллиметровка
    const out = [], step = 40, X = 520, Y = 380;
    for (let x = -X; x <= X; x += step) out.push(mkStroke('line', [[x, -Y], [x, Y]], '#3a4252', 1));
    for (let y = -Y; y <= Y; y += step) out.push(mkStroke('line', [[-X, y], [X, y]], '#3a4252', 1));
    return out;
  },
  music: () => {          // нотный стан (5 линий + тактовые черты)
    const out = [], X0 = -440, X1 = 440, dys = [-60, -30, 0, 30, 60];
    for (const dy of dys) out.push(mkStroke('line', [[X0, dy], [X1, dy]], '#6b7280', 1.5));
    for (const x of [X0, -160, 120, X1]) out.push(mkStroke('line', [[x, -60], [x, 60]], '#6b7280', 1.5));
    return out;
  },
  cat: () => {            // раскраска: кот
    const out = [];
    out.push(mkStroke('pen', circlePts(0, 10, 130), '#8a94a6', 2.5));            // голова
    out.push(mkStroke('pen', [[-90, -70], [-60, -140], [-30, -90]], '#8a94a6', 2.5)); // левое ухо
    out.push(mkStroke('pen', [[90, -70], [60, -140], [30, -90]], '#8a94a6', 2.5));   // правое ухо
    out.push(mkStroke('pen', circlePts(-45, 0, 12, 16), '#8a94a6', 2.5));         // левый глаз
    out.push(mkStroke('pen', circlePts(45, 0, 12, 16), '#8a94a6', 2.5));          // правый глаз
    out.push(mkStroke('pen', [[-10, 40], [0, 50], [10, 40], [0, 60], [-10, 40]], '#8a94a6', 2.5)); // нос+рот
    out.push(mkStroke('pen', [[-40, 55], [-110, 50]], '#8a94a6', 2));             // усы
    out.push(mkStroke('pen', [[-40, 65], [-110, 70]], '#8a94a6', 2));
    out.push(mkStroke('pen', [[40, 55], [110, 50]], '#8a94a6', 2));
    out.push(mkStroke('pen', [[40, 65], [110, 70]], '#8a94a6', 2));
    return out;
  },
  storyboard: () => {     // раскадровка 2×3
    const out = [], w = 260, h = 170, gx = 20, gy = 20;
    const x0 = -(3 * w + 2 * gx) / 2, y0 = -(2 * h + gy) / 2;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      const x = x0 + c * (w + gx), y = y0 + r * (h + gy);
      out.push(mkStroke('rect', [[x, y], [x + w, y + h]], '#5a6478', 2));
    }
    return out;
  },
  sudoku: () => {         // судоку 9×9, жирные 每 3
    const out = [], step = 48, N = 9, total = step * N, off = -total / 2;
    for (let i = 0; i <= N; i++) {
      const p = off + i * step, thick = i % 3 === 0;
      out.push(mkStroke('line', [[p, off], [p, off + total]], '#6b7280', thick ? 3 : 1));
      out.push(mkStroke('line', [[off, p], [off + total, p]], '#6b7280', thick ? 3 : 1));
    }
    return out;
  },
};
const TEMPLATE_LIST = [
  { key: 'grid',       name: 'Миллиметровка', icon: '▦' },
  { key: 'music',      name: 'Нотный стан',   icon: '♪' },
  { key: 'cat',        name: 'Раскраска: кот', icon: '🐱' },
  { key: 'storyboard', name: 'Раскадровка',   icon: '🎬' },
  { key: 'sudoku',     name: 'Судоку-сетка',  icon: '#' },
];
function setupTemplates() {
  const grid = $('#tpl-grid');
  const modal = $('#tpl-modal');
  if (!grid || !modal) return;
  grid.innerHTML = '';
  for (const t of TEMPLATE_LIST) {
    const el = document.createElement('div');
    el.className = 'tpl-item';
    el.innerHTML = `<div class="tpl-preview">${t.icon}</div><div class="tpl-name">${t.name}</div>`;
    el.addEventListener('click', () => {
      const strokes = (TEMPLATES[t.key] || (() => []))();
      if (!strokes.length) return;
      state.ydoc.transact(() => {
        state.yStrokes.push(strokes);
      }, 'template');
      fitView(); redrawMain();
      modal.classList.remove('show');
      showToast(`Шаблон «${t.name}» добавлен`, 'success', 1600);
    });
    grid.appendChild(el);
  }
  $('#tpl-close').addEventListener('click', () => modal.classList.remove('show'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
  $('#btn-templates').addEventListener('click', () => modal.classList.add('show'));
}

// ============ Экспорт PDF (jsPDF, клиентский) ============
async function downloadPDF() {
  const bb = strokesBBox();
  if (!state.yStrokes || state.yStrokes.length === 0) { showToast('Пусто — нечего выгружать', '', 1600); return; }
  showToast('Готовлю PDF…', '', 1200);
  const scale = 2;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bb.w * scale));
  out.height = Math.max(1, Math.round(bb.h * scale));
  const octx = out.getContext('2d');
  octx.fillStyle = '#11161f'; octx.fillRect(0, 0, out.width, out.height);
  octx.setTransform(scale, 0, 0, scale, -bb.x * scale, -bb.y * scale);
  const arr = (state.yStrokes.toArray() || []).slice().sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  for (const s of arr) drawStroke(octx, s);
  try {
    const jsPDF = await loadJsPDF();
    const orient = bb.w >= bb.h ? 'l' : 'p';
    const pdf = new jsPDF({ orientation: orient, unit: 'pt', format: [Math.round(bb.w), Math.round(bb.h)] });
    pdf.addImage(out.toDataURL('image/png'), 'PNG', 0, 0, Math.round(bb.w), Math.round(bb.h));
    pdf.save(`catscribbles-${state.roomCode}-${Date.now()}.pdf`);
    showToast('PDF скачан', 'success', 1400);
  } catch (e) {
    console.warn('PDF export failed', e);
    showToast('PDF недоступен — нет сети?', 'error', 1800);
  }
}

// ============ Telegram Mini App ============
// Приложение работает как Telegram WebApp: SDK грузится в index.html (no-op вне TG).
function tgWebApp() { return (window.Telegram && window.Telegram.WebApp) || null; }
function isTelegram() { return !!tgWebApp(); }
// TG SDK грузим динамически ТОЛЬКО внутри Telegram WebView (UA содержит 'Telegram').
// В обычном браузере (и в РФ без VPN) telegram.org заблокирован — не пытаемся, не блокируем старт.
function tgLikely() { return /Telegram/i.test(navigator.userAgent || ''); }
function loadTelegramSDK(timeoutMs = 4000) {
  return lazyScript('https://telegram.org/js/telegram-web-app.js', () => window.Telegram && window.Telegram.WebApp, timeoutMs);
}
async function setupTelegram() {
  if (!tgLikely()) return;                              // не в TG — не дёргаем заблокированный домен
  let tg = tgWebApp();
  if (!tg) {
    try { await loadTelegramSDK(); } catch (_) { return; }  // SDK не загрузился — тихо выходим
    tg = tgWebApp(); if (!tg) return;
  }
  tg.ready(); tg.expand();
  // тема TG → CSS-переменные (тёмная/светлая + акцент)
  const tp = tg.themeParams || {};
  const root = document.documentElement;
  if (tg.colorScheme === 'light') root.classList.add('tg-light');
  if (tp.bg_color) root.style.setProperty('--bg-1', '#' + tp.bg_color);
  if (tp.text_color) root.style.setProperty('--text', '#' + tp.text_color);
  if (tp.hint_color) root.style.setProperty('--text-mute', '#' + tp.hint_color);
  if (tp.button_color) root.style.setProperty('--bg-2', '#' + tp.button_color);
  if (tp.accent_text_color || tp.button_text_color) root.style.setProperty('--cyan', '#' + (tp.accent_text_color || tp.button_text_color));
  tg.setBackgroundColor?.(tp.bg_color || '#0a0d12');
  // авто-ник из профиля Telegram
  const u = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (u && u.first_name) {
    state._tgNick = (u.first_name + (u.last_name ? ' ' + u.last_name[0] + '.' : '')).slice(0, 18);
    const cn = $('#create-nick'), jn = $('#join-nick');
    [cn, jn].forEach(el => { if (el && !el.value) { el.value = state._tgNick; el.dispatchEvent(new Event('input', { bubbles: true })); } });
  }
  // BackButton: в комнате — выйти; на старте — закрыть WebApp
  const bb = tg.BackButton;
  const syncBack = () => {
    const inRoom = /#room=/.test(location.hash);
    if (inRoom) { bb.show(); } else { bb.hide(); }
  };
  bb.onClick(() => {
    if (/#room=/.test(location.hash)) { leaveRoom(); }
    else { tg.close(); }
  });
  window.addEventListener('hashchange', syncBack);
  syncBack();
}
// Кнопка «Поделиться в Telegram» в share-модалке (появляется только внутри TG).
function tgShareButton(link) {
  const tg = tgWebApp(); if (!tg) return null;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.style.cssText = 'width:100%;margin-top:10px';
  btn.textContent = '📤 Поделиться в Telegram';
  btn.addEventListener('click', () => {
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Рисуем вместе в CatScribbles 🐱');
    tg.openTelegramLink(url);
  });
  return btn;
}

// ============ AI «дорисуй скетч» (через Supabase Edge Function) ============
const AI_FN_URL = `${SB_URL.replace(/\/$/, '')}/functions/v1/ai-enhance`;
// Снимок холста по bbox штрихов, JPEG, длинная сторона ≤ 1024 (компактный payload).
function canvasSnapshot() {
  const bb = strokesBBox();
  if (!state.yStrokes || state.yStrokes.length === 0) return null;
  const maxSide = 1024;
  const scale = Math.min(2, maxSide / Math.max(bb.w, bb.h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bb.w * scale));
  out.height = Math.max(1, Math.round(bb.h * scale));
  const octx = out.getContext('2d');
  octx.fillStyle = '#11161f'; octx.fillRect(0, 0, out.width, out.height);
  octx.setTransform(scale, 0, 0, scale, -bb.x * scale, -bb.y * scale);
  const arr = (state.yStrokes.toArray() || []).slice().sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  for (const s of arr) drawStroke(octx, s);
  return out.toDataURL('image/jpeg', 0.88);
}
function setupAI() {
  const modal = $('#ai-modal'); if (!modal) return;
  const go = () => aiEnhance();
  $('#btn-ai').addEventListener('click', () => {
    $('#ai-result').style.display = 'none';
    $('#ai-status').textContent = '';
    modal.classList.add('show');
  });
  $('#ai-close').addEventListener('click', () => modal.classList.remove('show'));
  $('#ai-go').addEventListener('click', go);
  $('#ai-redo').addEventListener('click', go);
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
  $('#ai-download').addEventListener('click', () => {
    const img = $('#ai-result-img'); if (!img || !img.src) return;
    const a = document.createElement('a');
    a.download = `catscribbles-ai-${state.roomCode}-${Date.now()}.png`;
    a.href = img.src; a.click();
  });
}
async function aiEnhance() {
  if (!state.yStrokes || state.yStrokes.length === 0) { $('#ai-status').textContent = 'Холст пуст — сначала нарисуйте'; return; }
  const snap = canvasSnapshot();
  if (!snap) { $('#ai-status').textContent = 'Не удалось сделать снимок'; return; }
  const prompt = ($('#ai-prompt').value || '').trim() || 'Превратить скетч в законченный цифровой арт';
  const status = $('#ai-status'), result = $('#ai-result'), btn = $('#ai-go');
  result.style.display = 'none';
  status.textContent = 'Рисую… (10–20 сек)'; status.style.color = 'var(--cyan)';
  btn.disabled = true;
  try {
    const r = await fetch(AI_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_KEY}` },
      body: JSON.stringify({ image: snap, prompt, size: '1024x1024' }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(r.status === 404 ? 'функция не развёрнута (404)' : `${r.status} ${t.slice(0, 120)}`);
    }
    const data = await r.json();
    if (!data.image) throw new Error(data.error || 'нет изображения в ответе');
    $('#ai-result-img').src = data.image;
    result.style.display = 'block';
    status.textContent = 'Готово ✨'; status.style.color = 'var(--text-mute)';
  } catch (e) {
    status.textContent = 'AI недоступен: ' + (e.message || e) + ' — см. инструкции по развёртыванию функции';
    status.style.color = 'var(--danger, #ff5c7c)';
  } finally {
    btn.disabled = false;
  }
}

// ============ Debug-бар: диагностика Realtime sync + presence ============
function startDebugBar() {
  if (state._dbgTimer) clearInterval(state._dbgTimer);
  updateDebugBar();
  state._dbgTimer = setInterval(updateDebugBar, 800);
}
function updateDebugBar() {
  const bar = document.getElementById('debug-bar');
  if (!bar || state.destroyed) return;
  // Presence: сколько пиров реально в канале (по Supabase Realtime Presence)
  let presCount = 0;
  try {
    if (state.rtChannel) {
      const pres = state.rtChannel.presenceState ? state.rtChannel.presenceState() : {};
      presCount = Math.max(0, Object.keys(pres).length - 1);  // кроме себя
    }
  } catch (e) {}
  // Persistence: состояние сохранения в Supabase (db:ok = сохранено, ff = фолбэк на hash)
  const ps = state.persistStats || {};
  const dbTag = ps.save === 'ok' ? 'ok' : (ps.save && ps.save.startsWith('err')) ? 'ff' : '–';
  const s = state.syncStats || {};
  const aware = state.peerAwareness ? state.peerAwareness.size : 0;
  const strokes = state.yStrokes ? state.yStrokes.length : 0;
  const failTag = s.applyFail > 0 || s.lastErr ? ` <i>FAIL:${s.applyFail}${s.lastErr ? ' ' + s.lastErr : ''}</i>` : '';
  bar.innerHTML =
    `<b>RT</b> ${s.subStatus || '—'} pres:<b>${presCount}</b> peers:${state.peers} ` +
    `<b>db</b>:${dbTag} ` +
    `<b>aware</b>:${aware} <b>strokes</b>:${strokes} ` +
    `<b>sync</b> up ${s.rtSent}/${s.rtRecv} sync ${s.syncSent}/${s.syncRecv} ok:${s.applyOk}` +
    failTag;
}

// ============ Старт ============
window.__csReady = true;
// Экспонируем ключевые функции для тестов/отладки (безопасно — без секретов).
window.__csf = { drawGrid, strokesBBox, genRoomCode, downloadPDF, downloadPNG, selectTool, stickyHit, allStickies, logicalToScreen, pointerCoord, applyTemplate: (k) => { const f = TEMPLATES[k]; if (f) state.ydoc.transact(() => state.yStrokes.push(f())); } };
(function bootReady(){
  ['btn-create', 'btn-join'].forEach(function(id){
    var b = document.getElementById(id);
    if (!b) return;
    b.disabled = false;
    b.classList.remove('booting');
  });
  var t = document.getElementById('toast');
  if (t && t.classList.contains('show') && t.classList.contains('error')) {
    t.classList.remove('show'); // снять boot-ошибку, если приложение всё же загрузилось позже
  }
})();
console.log('[CatScribbles] boot, uid', state.userId.slice(0, 8));

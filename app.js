// ====================================================================
// CatScribbles (КошачьиЗакорючки) — совместная доска для рисования в реальном времени
// Архитектура:
//   • Yjs (CRDT) — общее состояние (штрихи, мета, ходы)
//   • Trystero 0.20.0 (torrent-стратегия, публичные WebTorrent-трекеры) — P2P-транспорт
//   • Ручная реализация Yjs sync-протокола через makeAction (step1/step2/update)
//   • Awareness (курсоры, ник, цвет, live-штрих) через отдельный makeAction
// Без сервера: данные идут напрямую между пирами по WebRTC.
// ====================================================================

import * as Y from 'https://esm.sh/yjs@13.6.21';
import { joinRoom, selfId } from 'https://esm.sh/trystero@0.20.0/torrent';
import QRCode from 'https://esm.sh/qrcode@1.5.4';

// ============ Константы ============
const APP_ID = 'raidopert.catscribbles.v1';
const MAX_PARTICIPANTS = 8;
const PALETTE = ['#00e5ff', '#ff2bd6', '#00ff88', '#ffb800', '#a78bff', '#ff5470', '#ff8a3d', '#ffffff'];
const USER_COLORS = ['#00e5ff', '#ff2bd6', '#00ff88', '#ffb800', '#a78bff', '#ff5470', '#00d4ff', '#ff8a3d'];
const ROOM_PREFIX = 'CS-';
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// ============ Утилиты ============
function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function genRoomCode() {
  // 6 символов из алфавита без похожих символов (без I,O,0,1) — ~617 млн комбинаций
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
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
  userId: selfId,    // Trystero selfId — уникальный в комнате
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
$('#btn-create').addEventListener('click', () => {
  const nick = $('#create-nick').value.trim();
  state.nick = nick;
  const code = genRoomCode();
  state.isHost = true;
  enterRoom(code);
});

$('#btn-join').addEventListener('click', () => {
  let code = $('#join-code').value.trim().toUpperCase();
  const nick = $('#join-nick').value.trim();
  state.nick = nick;
  if (!code) { showToast('Введите код комнаты', 'error'); $('#join-code').focus(); return; }
  if (!code.startsWith(ROOM_PREFIX)) code = ROOM_PREFIX + code.replace(ROOM_PREFIX, '');
  enterRoom(code);
});

$('#join-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});
$('#join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
$('#create-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-create').click(); });
$('#join-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });

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

// ============ Шеринг-модалка ============
const shareModal = $('#share-modal');

async function openShareModal() {
  const link = buildRoomLink();
  $('#share-code').textContent = state.roomCode;
  $('#share-link').textContent = link;
  const qrWrap = $('#qr-wrap');
  qrWrap.innerHTML = '';
  try {
    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, link, { width: 200, margin: 1, color: { dark: '#0a0d12', light: '#ffffff' } });
    qrWrap.appendChild(canvas);
  } catch (e) {
    console.warn('QR generation failed', e);
    qrWrap.textContent = 'QR недоступен';
  }
  shareModal.classList.add('show');
}
function closeShareModal() { shareModal.classList.remove('show'); }

$('#share-close').addEventListener('click', closeShareModal);
shareModal.addEventListener('click', e => { if (e.target === shareModal) closeShareModal(); });

$$('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = $('#' + btn.dataset.copy);
    const ok = await copyText(target.textContent);
    if (ok) { showToast('Скопировано', 'success', 1200); btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Копир.', 1000); }
    else showToast('Не удалось скопировать', 'error');
  });
});

function buildRoomLink() {
  const base = location.origin + location.pathname;
  return base + '#room=' + encodeURIComponent(state.roomCode);
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

  // 2) Trystero-комната (torrent-стратегия, публичные трекеры, STUN Google/Twilio)
  let room;
  try {
    room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, state.roomId);
    state.room = room;
  } catch (e) {
    console.error('Trystero init failed', e);
    showToast('Не удалось инициализировать P2P. Обновите страницу.', 'error', 4000);
    return;
  }

  // 3) Ручной Yjs sync-протокол через 3 makeAction (бинарные Uint8Array)
  const yjsSync = setupYjsSync(ydoc, room);

  // 4) Awareness (JSON: ник, цвет, курсор, live-штрих)
  setupAwareness(room);

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

  // 7) События пиров Trystero (ВАЖНО: onPeerJoin/onPeerLeave заменяют обработчик,
  //    поэтому регистрируем ОДИН раз — объединяем счётчик, awareness и Yjs sync)
  room.onPeerJoin((peerId) => {
    state.peers++;
    updateConnStatus();
    pushAwareness();
    // Yjs sync: отправляем новому пиру свой state vector
    yjsSync.sendStep1(peerId);
  });
  room.onPeerLeave((peerId) => {
    state.peers = Math.max(0, state.peers - 1);
    const leftUserId = state.peerUserId.get(peerId);
    state.peerAwareness.delete(peerId);
    state.peerUserId.delete(peerId);
    updateConnStatus();
    updateParticipants();
    redrawOverlay();
    if (leftUserId && state.yMeta.get('hostId') === leftUserId) {
      migrateHost();
    }
  });

  // 8) UI
  landing.style.display = 'none';
  roomEl.classList.add('active');
  $('#room-code-display').textContent = code;

  initCanvas();
  buildSwatches();
  setupToolbar();
  setupTopbar();
  updateModeUI();
  updateConnStatus();
  updateParticipants();   // показать свой аватар сразу
  pushAwareness();
  refreshHostUI();

  // Если создатель — сразу показать шеринг-модалку
  if (state.isHost) {
    setTimeout(openShareModal, 400);
  }

  // Resize
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));

  console.log('[CatScribbles] room joined', state.roomCode, 'as', state.userId.slice(0, 8));
}

// ============ Yjs sync: ручная реализация стандартного протокола ============
// Три бинарных действия (Uint8Array):
//   • yjs-step1: state vector — отправляем новому пиру, чтобы он знал что у нас есть
//   • yjs-step2: state update (diff) — ответ на step1, применяем у получателя
//   • yjs-update: инкрементальный update — рассылаем при локальном изменении
// Возвращает { sendStep1(peerId) } — вызвать при onPeerJoin.
function setupYjsSync(ydoc, room) {
  const [sendStep1, onStep1] = room.makeAction('yjs-step1');
  const [sendStep2, onStep2] = room.makeAction('yjs-step2');
  const [sendUpdate, onUpdate] = room.makeAction('yjs-update');

  // Получили state vector от пира — отвечаем diff'ом нашего состояния
  onStep1((vector, peerId) => {
    try {
      const update = Y.encodeStateAsUpdate(ydoc, vector);
      if (update.byteLength > 2) sendStep2(update, peerId);
    } catch (e) { console.warn('step2 send failed', e); }
  });

  // Получили state update — применяем
  onStep2((update, peerId) => {
    try { Y.applyUpdate(ydoc, update, 'remote'); } catch (e) { console.warn('step2 apply failed', e); }
  });

  // Локальное изменение — рассылаем инкрементальный update всем
  ydoc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    try { sendUpdate(update, null); } catch (e) { /* peer might be gone */ }
  });

  // Получили инкрементальный update — применяем
  onUpdate((update, peerId) => {
    try { Y.applyUpdate(ydoc, update, 'remote'); } catch (e) { console.warn('update apply failed', e); }
  });

  return {
    sendStep1: (peerId) => {
      try {
        const vector = Y.encodeStateVector(ydoc);
        sendStep1(vector, peerId);
      } catch (e) { console.warn('step1 send failed', e); }
    },
  };
}

// ============ Awareness (курсоры, ник, цвет, live-штрих) ============
let sendAware = null, onAware = null;

function setupAwareness(room) {
  [sendAware, onAware] = room.makeAction('aware');
  onAware((data, peerId) => {
    if (!data || !data.id) return;
    state.peerAwareness.set(peerId, data);
    state.peerUserId.set(peerId, data.id);
    updateParticipants();
    redrawOverlay();
  });
}

function pushAwareness(extra = {}) {
  if (!sendAware) return;
  const payload = {
    id: state.userId,
    nick: state.nick || ('user-' + state.userId.slice(0, 4)),
    color: state.userColor,
    cursor: state._cursor || null,
    drawing: state.isDrawing,
    liveStroke: state.isDrawing ? state.currentStroke : null,
    ...extra,
  };
  try { sendAware(payload, null); } catch (e) { /* ignore */ }
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
    txt.textContent = 'Рисуем одновременно';
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
function setupTopbar() {
  $('#room-badge').addEventListener('click', openShareModal);
  $('#btn-share').addEventListener('click', openShareModal);
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
  try { state.yStrokes && state.yStrokes.unobserve(onStrokesChange); } catch(e){}
  try { state.yMeta && state.yMeta.unobserve(onMetaChange); } catch(e){}
  try { state.room && state.room.leave(); } catch(e){}
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
  el.classList.remove('connecting', 'online', 'error');
  if (state.peers === 0) {
    el.classList.add('connecting');
    txt.textContent = 'Ждём второго игрока…';
  } else {
    el.classList.add('online');
    txt.textContent = state.peers + (state.peers === 1 ? ' игрок рядом' : ' игрока рядом');
  }
}

// ============ Холст ============
let dpr = 1;
let canvasW = 0, canvasH = 0;

function initCanvas() {
  onResize();
  liveCanvas.style.pointerEvents = 'none';
  mainCanvas.style.pointerEvents = 'none';
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointerleave', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
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
  mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawMain();
  redrawOverlay();
}

function pointerCoord(e) {
  const rect = stage.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function canDrawNow() {
  const mode = state.yMeta.get('mode') || 'simultaneous';
  if (mode === 'simultaneous') return true;
  return state.yMeta.get('currentTurn') === state.userId;
}

// ============ Рисование ============
function onPointerDown(e) {
  if (state.destroyed) return;
  if (!canDrawNow()) { showToast('Не ваш ход', 'error', 1200); return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const [x, y] = pointerCoord(e);
  state._cursor = [x, y];

  if (state.tool === 'text') {
    spawnTextInput(x, y);
    return;
  }

  state.isDrawing = true;
  state.redoStack = [];
  state.currentStroke = {
    id: uuid(),
    tool: state.tool,
    color: state.color,
    size: state.size,
    layer: state.layer,
    author: state.userId,
    authorColor: state.userColor,
    points: [[x, y]],
    ts: Date.now(),
  };
  try { stage.setPointerCapture(e.pointerId); } catch(_) {}
  pushAwareness();
  redrawOverlay();
}

function onPointerMove(e) {
  const [x, y] = pointerCoord(e);
  state._cursor = [x, y];
  if (state.isDrawing && state.currentStroke) {
    const pts = state.currentStroke.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 1.2) {
      pts.push([x, y]);
      pushCursorAwareness();
      redrawOverlay();
    }
  } else {
    pushCursorAwareness();
  }
}

function onPointerUp(e) {
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
  input.style.left = x + 'px';
  input.style.top = (y - 14) + 'px';
  const fontSize = clamp(state.size * 3, 14, 72);
  input.style.fontSize = fontSize + 'px';
  input.style.color = state.color;
  input.style.borderColor = state.color;
  stage.appendChild(input);
  setTimeout(() => input.focus(), 10);

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

// ============ Отрисовка ============
function onStrokesChange() { redrawMain(); }

function redrawMain() {
  if (state.destroyed) return;
  mainCtx.clearRect(0, 0, canvasW, canvasH);
  const arr = state.yStrokes.toArray();
  arr.sort((a, b) => (a.layer || 0) - (b.layer || 0) || (a.ts || 0) - (b.ts || 0));
  for (const s of arr) drawStroke(mainCtx, s);
}

function redrawOverlay() {
  if (state.destroyed) return;
  liveCtx.clearRect(0, 0, canvasW, canvasH);
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

function drawStroke(ctx, s, overrideColor) {
  if (!s || !s.points) return;
  ctx.save();
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = overrideColor || s.color;
    ctx.fillStyle = overrideColor || s.color;
  }
  ctx.lineWidth = s.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (s.tool === 'text' && s.text) {
    const fontSize = clamp(s.size * 3, 14, 72);
    ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, s.points[0][0], s.points[0][1]);
  } else if (s.points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for (let i = 1; i < s.points.length - 1; i++) {
      const [x, y] = s.points[i];
      const [nx, ny] = s.points[i + 1];
      const mx = (x + nx) / 2, my = (y + ny) / 2;
      ctx.quadraticCurveTo(x, y, mx, my);
    }
    const last = s.points[s.points.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  } else if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(s.points[0][0], s.points[0][1], Math.max(0.5, s.size / 2), 0, Math.PI * 2);
    ctx.fill();
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
    let lx = x + 10, ly = y - 18;
    if (lx + w > canvasW) lx = x - w - 10;
    if (ly < 4) ly = y + 14;
    ctx.fillStyle = 'rgba(10,13,18,.78)';
    ctx.fillRect(lx, ly, w, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, lx + 5, ly + 13);
  }
  ctx.restore();
}

// ============ Тулбар ============
function setupToolbar() {
  $$('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
    });
  });
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
  const out = document.createElement('canvas');
  out.width = mainCanvas.width;
  out.height = mainCanvas.height;
  const octx = out.getContext('2d');
  octx.fillStyle = '#11161f';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(mainCanvas, 0, 0);
  const link = document.createElement('a');
  link.download = `catscribbles-${state.roomCode}-${Date.now()}.png`;
  link.href = out.toDataURL('image/png');
  link.click();
  showToast('Скачано', 'success', 1200);
}

// ============ Старт ============
window.__csReady = true;
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

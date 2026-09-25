// Экраны, отрисовка и обработчики. Единственный модуль, который трогает DOM.
//
// Здесь же живёт state — один объект на вкладку. Остальные модули его не видят: api.js
// получает сессию параметром, поэтому импорт идёт только в одну сторону.

import { CODE_LEN, checkChar, grouped, newCode, normalize } from './code.js';
import { DEC, ENC, b64u, derive, unb64u } from './crypto.js';
import { loadDevice, saveDevice as persistDevice, wipeDevice } from './store.js';
import {
  MAX_FILES, MAX_FILE_BYTES, TEXT_SLOT,
  api, fetchRecord, fetchText, parseItems, send, sendText,
} from './api.js';
import { describeAgent } from './agent.js';
import { qrMatrix } from './qr.js';
import { diffLines } from './diff.js';

const state = {
  roomKey: null, encKey: null, seqs: {}, persist: true,
  // remote is the text the server holds; files is the manifest from slot 0. File bytes
  // are never held here: they are fetched when someone asks for them.
  remote: '', ts: 0, files: [], from: '',
  // name — моя метка для собеседника («Вася»), она же заголовок вкладки. Своя у каждой
  // вкладки и никуда не отправляется: для той стороны она смысла не имеет.
  name: '',
  // Настройки устройства: одни на все вкладки, живут в записи рядом с ключами.
  deviceName: '', autoRefresh: false,
};

// То, что видит api.js: ключи, счётчики и способ их сохранить — без DOM и без остального
// состояния интерфейса.
state.save = () => saveDevice();

// store.js ничего не знает про state: обёртки передают ему ровно то, что нужно записать,
// и соблюдают правило «пишем только когда устройство запоминается».
const saveDevice = () => (state.persist
  ? persistDevice(state).catch(() => setStatus('send-status', 'key not saved here', true))
  : Promise.resolve());

const $ = (id) => document.getElementById(id);
const room = () => b64u(state.roomKey);

function show(name) {
  for (const el of document.querySelectorAll('.screen')) {
    el.hidden = el.dataset.screen !== name;
  }
}

function setStatus(id, message, bad) {
  const el = $(id);
  el.textContent = message || '';
  el.classList.toggle('bad', !!bad);
}

// The only failures worth a word: the request did not get through.
const reason = (err) => (err.status === 429 ? 'too many requests' : 'no connection');

function ago(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  return Math.round(hours / 24) + ' days ago';
}

// writeText has to be reached with no await in front of it or iOS Safari drops the
// user gesture and silently fails, which is why decrypted text is held in memory.

function legacyCopy(text) {
  const scratch = document.createElement('textarea');
  scratch.className = 'offscreen';
  scratch.value = text;
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  scratch.remove();
  return ok;
}

function copyNow(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      return true;
    }
  } catch (err) { /* fall through */ }
  return legacyCopy(text);
}

// The box is the room's text and the draft at once, so "changed" is simply the box
// differing from what the server is known to hold. Nothing else needs tracking.
const dirty = () => $('box').value !== state.remote;

function syncSend() {
  $('btn-send').disabled = !dirty();
}

function renderBox() {
  const shown = state.remote || state.files.length;
  $('from').textContent = shown && state.from ? 'from ' + state.from : '';
  $('age').textContent = shown && state.ts ? ago(state.ts) : '';
  renderFiles();
  syncSend();
}

const KB = 1024;
function humanSize(bytes) {
  if (bytes < KB) return bytes + ' B';
  if (bytes < KB * KB) return Math.round(bytes / KB) + ' KB';
  return (bytes / (KB * KB)).toFixed(1) + ' MB';
}

function renderFiles() {
  const host = $('files');
  host.textContent = '';
  $('btn-attach').disabled = state.files.length >= MAX_FILES;

  for (const file of state.files) {
    const row = document.createElement('div');
    row.className = 'file';

    const name = document.createElement('button');
    name.className = 'link grow';
    name.textContent = file.name;
    name.title = 'Download ' + file.name;
    name.addEventListener('click', () => downloadFile(file));

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = humanSize(file.size);

    const remove = document.createElement('button');
    remove.className = 'link';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove ' + file.name);
    remove.addEventListener('click', () => removeFile(file));

    row.append(name, size, remove);
    host.appendChild(row);
  }
}

// Joined rather than reduced to items[0]: a record written by another client may hold
// more than one item, and dropping the rest would silently lose text.
const textOf = (items) => items.map((item) => item.text).join('\n');

function load(text, files, from) {
  $('box').value = text;
  state.remote = text;
  state.files = files;
  state.from = from || '';
  renderBox();
}

// Above this, an O(N·D) line diff risks a visible stall on a huge paste; the documented
// use case is short secrets, so real use never gets near it.
const MAX_DIFF_CHARS = 200_000;

function renderDiffLines(ops) {
  return ops.map((op) => {
    const line = document.createElement('div');
    line.className = op.type === 'same' ? 'diff-line' : 'diff-line diff-' + op.type;
    line.textContent = op.text;
    return line;
  });
}

// Shown over the box rather than merged into it: a plain textarea cannot color part of
// its own value, so the highlighted view and the editable box are two elements, toggled
// like the tab-name display/input pair above.
function showDiff(oldText, newText) {
  if (oldText.length + newText.length > MAX_DIFF_CHARS) return;
  $('diff-lines').replaceChildren(...renderDiffLines(diffLines(oldText, newText)));
  $('box').hidden = true;
  $('diff-view').hidden = false;
  $('btn-diff-close').focus();
}

function hideDiff() {
  $('diff-view').hidden = true;
  $('box').hidden = false;
  $('box').focus();
}

$('btn-diff-close').addEventListener('click', hideDiff);

let lastRefresh = 0;

async function refresh(quiet) {
  if (!state.roomKey) return;
  // visibilitychange and focus both fire when you switch back to the tab, and a habit
  // of alt-tabbing should not spend the room's rate limit.
  const now = Date.now();
  if (quiet && now - lastRefresh < 2000) return;
  lastRefresh = now;
  try {
    const result = await fetchText(state);
    if (result.kind === 'rollback') {
      setStatus('send-status', 'ignored an older version', true);
      return;
    }
    if (result.kind === 'undecryptable') {
      // The box is the user's text as much as the room's, so it is not thrown away
      // because this end cannot read what the other end wrote.
      setStatus('send-status', 'cannot decrypt — different code?', true);
      return;
    }
    if (result.kind === 'empty') {
      state.ts = 0;
      if (!dirty()) load('', [], '');
      else { state.remote = ''; state.files = []; state.from = ''; renderBox(); }
      return;
    }
    const text = textOf(result.items);
    const previous = state.remote;
    // Nothing to diff against on the very first record this tab ever loads — state.ts
    // is only 0 before that happens.
    const hadPrevious = state.ts !== 0;
    // An edited box is never overwritten by a background refresh — not even with the
    // same text it already holds, which is what switching tabs used to do. Only the
    // Refresh button, an explicit act, replaces what you typed. Attachments are not a
    // draft, so they land either way.
    if (quiet && dirty()) {
      state.files = result.files;
      state.from = result.from;
      renderBox();
      if (text !== previous) {
        setStatus('send-status', 'newer text — press Refresh');
        if (hadPrevious) showDiff(previous, text);
      }
      return;
    }
    state.ts = result.ts;
    load(text, result.files, result.from);
    if (!quiet) setStatus('send-status', '');
    if (hadPrevious && text !== previous) showDiff(previous, text);
  } catch (err) {
    setStatus('send-status', reason(err), true);
  }
}

async function activate(code, persist) {
  const keys = await derive(code);
  state.roomKey = keys.roomKey;
  state.encKey = keys.encKey;
  state.persist = persist;
  state.seqs = {};
  state.remote = '';
  state.files = [];
  if (persist) {
    await saveDevice();
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (err) { /* best effort */ }
    }
  }
  show('main');
  load('', [], '');
  renderSettings();
  schedulePolling();
  await refresh(true);
}

async function resume() {
  const saved = await loadDevice();
  if (!saved || !saved.roomKey || !saved.encKey) return false;
  state.roomKey = saved.roomKey instanceof Uint8Array
    ? saved.roomKey : new Uint8Array(saved.roomKey);
  state.encKey = saved.encKey;
  state.seqs = (saved.seqs && typeof saved.seqs === 'object') ? saved.seqs : {};
  applySettings(saved);
  state.persist = true;
  show('main');
  load('', [], '');
  schedulePolling();
  await refresh(true);
  return true;
}

let pendingCode = null;
let pendingIsRotation = false;

// One <path> rather than a rect per module, and a viewBox carrying the four-module
// quiet zone the spec requires.
function renderQr(host, text) {
  host.textContent = '';
  const code = qrMatrix(text);
  host.style.display = code ? 'block' : 'none';
  if (!code) return;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${code.size + 8} ${code.size + 8}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing link as a QR code');

  const background = document.createElementNS(NS, 'rect');
  background.setAttribute('x', -4);
  background.setAttribute('y', -4);
  background.setAttribute('width', code.size + 8);
  background.setAttribute('height', code.size + 8);
  background.setAttribute('fill', '#fff');

  let d = '';
  for (let row = 0; row < code.size; row++) {
    for (let col = 0; col < code.size; col++) {
      if (code.modules[row * code.size + col]) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');

  svg.append(background, path);
  host.appendChild(svg);
}

// Заголовок, каким вкладка называется до того, как её переименовали: он же плейсхолдер.
const DEFAULT_TITLE = document.title;

// Имя вкладки — своё у каждой вкладки, поэтому sessionStorage, а не запись устройства:
// та общая для всех вкладок домена, и две вкладки затирали бы имя друг у друга.
const TAB_NAME_KEY = 'tab-name';
const tabStore = {
  get(key) { try { return sessionStorage.getItem(key); } catch (err) { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch (err) { /* приватный режим */ } },
};

function applyName(name) {
  state.name = name;
  const field = $('tab-name');
  const display = $('tab-name-display');
  field.value = name;
  field.placeholder = DEFAULT_TITLE;
  // Ширина по содержимому: растянутое на всю ширину поле выглядит как форма, а не как
  // заголовок. size работает везде, в отличие от field-sizing:content.
  field.size = Math.max(6, Math.min(40, (name || DEFAULT_TITLE).length + 1));
  display.textContent = name || DEFAULT_TITLE;
  display.classList.toggle('placeholder', !name);
  document.title = name || DEFAULT_TITLE;
}

applyName(tabStore.get(TAB_NAME_KEY) || '');

// Текст по умолчанию, редактирование — по клику; переключение через hidden, как экраны.
function enterEdit() {
  $('tab-name-display').hidden = true;
  const field = $('tab-name');
  field.hidden = false;
  field.focus();
  field.select();
}
function exitEdit() {
  $('tab-name').hidden = true;
  $('tab-name-display').hidden = false;
}

$('tab-name-display').addEventListener('click', enterEdit);

$('tab-name').addEventListener('input', () => {
  applyName($('tab-name').value);
  tabStore.set(TAB_NAME_KEY, state.name.trim());
});

for (const event of ['blur', 'change']) {
  $('tab-name').addEventListener(event, () => {
    applyName($('tab-name').value.trim());
    tabStore.set(TAB_NAME_KEY, state.name);
    exitEdit();
  });
}

$('tab-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('tab-name').blur();
});

// --- настройки устройства ----------------------------------------------------
// Одни на все вкладки домена, поэтому лежат в записи устройства, а не в sessionStorage,
// и расходятся между открытыми вкладками через BroadcastChannel.

const channel = ('BroadcastChannel' in globalThis)
  ? new BroadcastChannel('web-clipboard') : null;
if (channel) {
  channel.onmessage = (event) => {
    if (event.data && event.data.kind === 'settings') applySettings(event.data.settings);
  };
}

function applySettings(saved) {
  state.deviceName = typeof saved.deviceName === 'string' ? saved.deviceName : '';
  state.autoRefresh = saved.autoRefresh === true;
  renderSettings();
  schedulePolling();
}

function renderSettings() {
  $('device-name').value = state.deviceName;
  $('chk-auto').checked = state.autoRefresh && state.persist;
  // На рабочей ВМ устройство не запоминается, значит настройку негде хранить и опрос не
  // запускается. Это свойство кода, а не дисциплина пользователя.
  $('chk-auto').disabled = !state.persist;
  $('auto-note').textContent = state.persist
    ? 'Checks every ' + (POLL_MS / 1000) + ' seconds while this tab is in front. '
      + 'It never overwrites text you are still typing.'
    : 'Not available: this device is not being remembered, so nothing about it is '
      + 'stored here — which is what you want on a machine you do not own.';
}

function saveSettings() {
  renderSettings();
  schedulePolling();
  if (channel) {
    channel.postMessage({
      kind: 'settings',
      settings: { deviceName: state.deviceName, autoRefresh: state.autoRefresh },
    });
  }
  return saveDevice();
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  show('settings');
});

$('btn-settings-back').addEventListener('click', () => show('main'));

$('device-name').addEventListener('change', () => {
  state.deviceName = $('device-name').value.trim();
  saveSettings();
});

$('chk-auto').addEventListener('change', () => {
  state.autoRefresh = $('chk-auto').checked;
  saveSettings();
});

// --- размер карточки ---------------------------------------------------------
// Родной уголок textarea выключен: тянем за угол самой карточки, и поле растёт вместе с
// ней. Высота своя у каждой вкладки, поэтому sessionStorage.

const CARD_HEIGHT_KEY = 'card-height';
const MIN_CARD_HEIGHT = 240;
const card = () => $('grip').parentElement;

function applyCardHeight(px) {
  const el = card();
  if (px) {
    el.style.flex = 'none';
    el.style.height = px + 'px';
  } else {
    el.style.flex = '';
    el.style.height = '';
  }
}

applyCardHeight(Number(tabStore.get(CARD_HEIGHT_KEY)) || 0);

$('grip').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  // Захват курсора, иначе перетаскивание рвётся, стоит выйти за пределы хвата.
  $('grip').setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = card().getBoundingClientRect().height;

  const onMove = (move) => {
    const height = Math.max(MIN_CARD_HEIGHT, Math.round(startHeight + move.clientY - startY));
    applyCardHeight(height);
  };
  const onUp = () => {
    $('grip').removeEventListener('pointermove', onMove);
    $('grip').removeEventListener('pointerup', onUp);
    tabStore.set(CARD_HEIGHT_KEY, String(Math.round(card().getBoundingClientRect().height)));
  };
  $('grip').addEventListener('pointermove', onMove);
  $('grip').addEventListener('pointerup', onUp);
});

// Двойной клик возвращает карточку к «во весь экран».
$('grip').addEventListener('dblclick', () => {
  applyCardHeight(0);
  tabStore.set(CARD_HEIGHT_KEY, '');
});

// --- автообновление ----------------------------------------------------------

const POLL_MS = 10_000;
let pollTimer = null;

// Опрос идёт только при запомненном устройстве и только когда вкладка на виду: десяток
// фоновых вкладок иначе съел бы лимит комнаты (120 запросов на 10 минут).
function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!state.autoRefresh || !state.persist || !state.roomKey) return;
  if (document.visibilityState !== 'visible') return;
  pollTimer = setInterval(() => refresh(true), POLL_MS);
}

function showCreated(code, isRotation) {
  pendingCode = code;
  pendingIsRotation = isRotation;
  $('new-code').textContent = grouped(code);
  renderQr($('qr'), location.origin + '/#' + code);
  setStatus('created-status', '');
  show('created');
}

$('btn-create').addEventListener('click', async () => {
  showCreated(await newCode(), false);
});

$('btn-have').addEventListener('click', () => {
  setStatus('enter-status', '');
  $('code-input').value = '';
  show('enter');
  $('code-input').focus();
});

$('btn-copy-code').addEventListener('click', () => {
  $('btn-copy-code').textContent = copyNow(grouped(pendingCode)) ? 'Copied' : 'Select it manually';
});

$('btn-copy-link').addEventListener('click', () => {
  const link = location.origin + '/#' + pendingCode;
  $('btn-copy-link').textContent = copyNow(link) ? 'Copied' : 'Select it manually';
});

$('btn-created-go').addEventListener('click', async () => {
  const code = pendingCode;
  try {
    if (pendingIsRotation && state.roomKey) {
      try { await api('/api/clear', { room: room() }); } catch (err) { /* old room may be gone */ }
      await wipeDevice();
    }
    await activate(code, true);
  } catch (err) {
    setStatus('created-status', 'Could not set up this device.', true);
  }
});

$('btn-enter-back').addEventListener('click', () => show('pair'));

$('btn-enter-go').addEventListener('click', async () => {
  const code = await normalize($('code-input').value);
  if (!code) {
    setStatus('enter-status', 'That code does not look right — check for a typo.', true);
    return;
  }
  setStatus('enter-status', '');
  try {
    await activate(code, $('chk-remember').checked);
  } catch (err) {
    setStatus('enter-status', 'Could not set up this device.', true);
  }
});

$('code-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('btn-enter-go').click();
});

$('btn-refresh').addEventListener('click', () => refresh(false));
$('box').addEventListener('input', syncSend);

$('btn-send').addEventListener('click', async () => {
  const items = parseItems($('box').value);
  $('btn-send').disabled = true;
  setStatus('send-status', '');
  try {
    if (items.length || state.files.length) {
      await sendText(state, $('box').value, state.files, parseItems($('box').value));
      // The text actually sent, so a trailing newline cannot leave the box dirty
      // against a value the server never saw. The button greying out is the receipt;
      // there is nothing to announce.
      state.ts = Date.now();
      load(items.length ? items[0].text : '', state.files, describeAgent());
    } else {
      // Nothing left to share at all: drop the room, attachments and seq floors with it.
      await api('/api/clear', { room: room() });
      state.seqs = {};
      state.ts = 0;
      await saveDevice();
      load('', [], '');
    }
  } catch (err) {
    setStatus('send-status', reason(err), true);
  } finally {
    syncSend();
  }
});

// Lowest free slot, so removing the middle file does not strand the numbering.
function freeSlot() {
  const taken = new Set(state.files.map((file) => file.slot));
  for (let slot = 1; slot <= MAX_FILES; slot++) if (!taken.has(slot)) return slot;
  return null;
}

// The manifest is written from state.remote rather than from the box: attaching a file
// must not publish text the user has not chosen to send yet.
const saveManifest = (files) => sendText(state, state.remote, files, parseItems(state.remote));

$('btn-attach').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async () => {
  const chosen = [...$('file-input').files];
  // Cleared first: picking the same file twice in a row must still fire a change event.
  $('file-input').value = '';
  setStatus('send-status', '');

  for (const file of chosen) {
    if (state.files.length >= MAX_FILES) {
      setStatus('send-status', 'at most ' + MAX_FILES + ' files', true);
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus('send-status', 'file too large — ' + humanSize(MAX_FILE_BYTES) + ' max', true);
      continue;
    }
    const slot = freeSlot();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Bytes first, manifest second: a manifest is never allowed to name a slot that
      // does not exist yet. The reverse order would show a peer a broken download.
      await send(state, slot, bytes);
      const next = [...state.files,
        { slot, name: safeName(file.name), type: file.type || '', size: file.size }];
      await saveManifest(next);
      state.files = next;
      renderFiles();
    } catch (err) {
      setStatus('send-status', reason(err), true);
      break;
    }
  }
});

async function removeFile(file) {
  const next = state.files.filter((other) => other.slot !== file.slot);
  try {
    // Manifest first here, for the same reason: no window where it names a dead slot.
    await saveManifest(next);
    state.files = next;
    renderFiles();
    await api('/api/clear', { room: room(), slot: file.slot });
    delete state.seqs[file.slot];
    await saveDevice();
  } catch (err) {
    setStatus('send-status', reason(err), true);
  }
}

async function downloadFile(file) {
  setStatus('send-status', '');
  try {
    const result = await fetchRecord(state, file.slot);
    if (result.kind !== 'ok') {
      setStatus('send-status',
        result.kind === 'empty' ? 'file is gone' : 'cannot decrypt that file', true);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([result.plaintext], { type: file.type || 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    setStatus('send-status', reason(err), true);
  }
}

// A name travels from another device and ends up in a download attribute: keep it to one
// harmless path segment.
const safeName = (name) => name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120) || 'file';

$('btn-repair').addEventListener('click', async () => {
  showCreated(await newCode(), true);
});

$('btn-unlink').addEventListener('click', async () => {
  try { await api('/api/clear', { room: room() }); } catch (err) { /* best effort */ }
  await wipeDevice();
  location.replace(location.origin + '/');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomKey) refresh(true);
  schedulePolling();
});
window.addEventListener('focus', () => { if (state.roomKey) refresh(true); });

(async () => {
  if (!crypto || !crypto.subtle) {
    // Either the page is not on HTTPS, or policy has disabled WebCrypto. Encrypting
    // in the browser is the whole design, so there is no degraded mode to offer.
    $('pair-note').textContent = 'This browser will not let the page encrypt anything, ' +
      'so it cannot be used here. That usually means the site was opened over plain ' +
      'HTTP rather than HTTPS.';
    $('btn-create').disabled = true;
    $('btn-have').disabled = true;
    show('pair');
    return;
  }

  const fromLink = location.hash ? await normalize(location.hash.slice(1)) : null;
  if (fromLink) {
    // Strip it before anything else can read it back off the address bar.
    history.replaceState(null, '', location.pathname);
    try {
      await activate(fromLink, true);
      return;
    } catch (err) { /* fall through to the pairing screen */ }
  }

  if (await resume()) return;
  show('pair');
})();

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

const state = {
  roomKey: null, encKey: null, seqs: {}, persist: true,
  // remote is the text the server holds; files is the manifest from slot 0. File bytes
  // are never held here: they are fetched when someone asks for them.
  remote: '', ts: 0, files: [], from: '',
  // name — это моя метка для собеседника («Вася»), она же заголовок вкладки. Ни в одну
  // запись она не уходит: для той стороны она смысла не имеет.
  name: '',
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
    // An edited box is never overwritten by a background refresh — not even with the
    // same text it already holds, which is what switching tabs used to do. Only the
    // Refresh button, an explicit act, replaces what you typed. Attachments are not a
    // draft, so they land either way.
    if (quiet && dirty()) {
      state.files = result.files;
      state.from = result.from;
      renderBox();
      if (text !== state.remote) {
        setStatus('send-status', 'newer text — press Refresh');
      }
      return;
    }
    state.ts = result.ts;
    load(text, result.files, result.from);
    if (!quiet) setStatus('send-status', '');
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
  await refresh(true);
}

async function resume() {
  const saved = await loadDevice();
  if (!saved || !saved.roomKey || !saved.encKey) return false;
  state.roomKey = saved.roomKey instanceof Uint8Array
    ? saved.roomKey : new Uint8Array(saved.roomKey);
  state.encKey = saved.encKey;
  state.seqs = (saved.seqs && typeof saved.seqs === 'object') ? saved.seqs : {};
  applyName(typeof saved.name === 'string' ? saved.name : '');
  state.persist = true;
  show('main');
  load('', [], '');
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
let nameTimer = null;

function applyName(name) {
  state.name = name;
  $('tab-name').value = name;
  $('tab-name').placeholder = DEFAULT_TITLE;
  document.title = name || DEFAULT_TITLE;
}

applyName('');   // плейсхолдер на месте и до того, как устройство спарено

$('tab-name').addEventListener('input', () => {
  state.name = $('tab-name').value;
  document.title = state.name.trim() || DEFAULT_TITLE;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => saveDevice(), 400);
});

// Запись на диск идёт через saveDevice, то есть только при «запомнить это устройство»:
// на чужой машине метка остаётся в памяти вкладки и следа не оставляет.
for (const event of ['blur', 'change']) {
  $('tab-name').addEventListener(event, () => {
    clearTimeout(nameTimer);
    applyName($('tab-name').value.trim());
    saveDevice();
  });
}

$('tab-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('tab-name').blur();
});

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

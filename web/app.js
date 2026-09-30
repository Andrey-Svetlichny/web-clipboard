// Screens, rendering and handlers. The only module that touches the DOM.
//
// It also holds state, one object per tab. The other modules never see it: api.js takes
// the session as a parameter, so imports only ever go one way.

import { grouped, newCode, normalize } from './code.js';
import { b64u, derive } from './crypto.js';
import { loadDevice, saveDevice, wipeDevice } from './store.js';
import {
  MAX_FILES, MAX_FILE_BYTES,
  api, fetchRecord, fetchText, origin, parseItems, room, safeName, send, sendText,
} from './api.js';
import { describeAgent } from './agent.js';
import { canDiff, diffLines } from './diff.js';
import { qrMatrix } from './qr.js';

// --- state ------------------------------------------------------------------

const state = {
  roomKey: null, encKey: null, seqs: {}, persist: true,
  // remote is the text the server holds; files is the manifest from slot 0. File bytes
  // are never held here: they are fetched when someone asks for them.
  remote: '', ts: 0, files: [], from: '',
  // mine: remote was written by this device (any tab of it) — shown as "You".
  mine: false,
  // ours is my own version: the Local view, and what Save sends. An update only ever
  // replaces remote (the Shared view), so however many arrive, the diff is against ours
  // rather than against the previous one received. Editing Shared makes it ours.
  ours: '',
  // Device settings: one set for every tab, kept in the record alongside the keys.
  deviceName: '', autoRefresh: false,
  // Random, never shown: marks our own records so they read "You" (see api.js sendText).
  deviceId: '',
};

// store.js knows nothing of state: this hands it exactly what to write, and keeps the
// rule that nothing is written unless the device is remembered.
function saveState() {
  if (!state.persist) return Promise.resolve();
  return saveDevice(state).catch(() => setStatus('main-status', 'key not saved here', true));
}

// api.js receives state as its session: the keys, the counters and a way to save them.
state.save = saveState;

// --- helpers ----------------------------------------------------------------

const $ = (id) => document.getElementById(id);

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
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  return Math.round(hours / 24) + ' days ago';
}

const KB = 1024;

function humanSize(bytes) {
  if (bytes < KB) return bytes + ' B';
  if (bytes < KB * KB) return Math.round(bytes / KB) + ' KB';
  return (bytes / (KB * KB)).toFixed(1) + ' MB';
}

// Per-tab settings live in sessionStorage, which a private window may refuse outright.
const tabStore = {
  get(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* private mode: not remembered */ }
  },
};

// The pre-Clipboard-API way: select the text in a hidden field and run the copy command.
function legacyCopy(text) {
  const scratch = document.createElement('textarea');
  scratch.className = 'offscreen';
  scratch.value = text;
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* unsupported: not copied */ }
  scratch.remove();
  return ok;
}

// writeText has to be reached with no await in front of it, or iOS Safari drops the user
// gesture and the copy silently fails; that is why the code is held in memory. For the
// same reason the legacy path runs only where the async API is missing, synchronously,
// and never after a rejected writeText, by when the gesture may be gone.
async function copyNow(text) {
  let writing = null;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      writing = navigator.clipboard.writeText(text);
    }
  } catch { /* fall back below */ }
  if (!writing) return legacyCopy(text);
  try {
    await writing;
    return true;
  } catch {
    return false;
  }
}

// --- screens ----------------------------------------------------------------

let currentScreen = 'loading';

function show(name) {
  currentScreen = name;
  for (const el of document.querySelectorAll('.screen')) {
    el.hidden = el.dataset.screen !== name;
  }
  scheduleAgo();
}

// Sub-screens get a history entry of their own: on a phone the back gesture otherwise
// leaves the page — closing the app — instead of returning to the screen underneath.
function setRoot(name) {
  show(name);
  history.replaceState({ screen: name }, '');
}

function goTo(name) {
  history.pushState({ screen: name }, '');
  show(name);
}

window.addEventListener('popstate', (event) => {
  const target = event.state && event.state.screen;
  if (!target) return;
  // Once paired, the pairing screens left behind in the history make no sense.
  const allowed = state.roomKey ? ['main', 'settings'] : ['pair', 'enter', 'created'];
  if (allowed.includes(target)) show(target);
  else setRoot(state.roomKey ? 'main' : 'pair');
});

// --- main view --------------------------------------------------------------

// Which version the card shows: 'local' (ours), 'diff' or 'shared' (remote). One
// textarea serves both editable versions; switching views swaps its value.
const VIEWS = ['local', 'diff', 'shared'];
let view = 'local';

const differs = () => state.ours !== state.remote;

// Save is off on an untouched Shared view: it would publish ours over a version the user
// is looking at but has not taken.
const dirty = () => view !== 'shared' && differs();

function syncSave() {
  $('btn-save').disabled = !dirty();
}

function renderMeta() {
  const shown = state.remote || state.files.length;
  $('from').textContent = shown ? (state.mine ? 'You' : state.from) : '';
  $('age').textContent = shown && state.ts ? ago(state.ts) : '';
}

function renderFiles() {
  const host = $('files');
  host.textContent = '';
  $('btn-attach').disabled = state.files.length >= MAX_FILES;

  for (const file of state.files) {
    const row = document.createElement('div');
    row.className = 'file';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'link grow';
    name.textContent = file.name;
    name.title = 'Download ' + file.name;
    name.addEventListener('click', () => downloadFile(file));

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = humanSize(file.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove ' + file.name);
    remove.addEventListener('click', () => removeFile(file));

    row.append(name, size, remove);
    host.appendChild(row);
  }
}

function renderDiffLines(ops) {
  return ops.map((op) => {
    const line = document.createElement('div');
    line.className = op.type === 'same' ? 'diff-line' : 'diff-line diff-' + op.type;
    line.textContent = op.text;
    return line;
  });
}

// The diff is shown instead of the box rather than merged into it: a plain textarea
// cannot colour part of its own value, so the highlighted view and the editable box are
// two elements, toggled with hidden like the screens.
function renderView() {
  const diffable = canDiff(state.ours, state.remote);
  // The switcher stays put; with nothing to compare only Local makes sense.
  if (!differs() || (view === 'diff' && !diffable)) view = 'local';
  for (const name of VIEWS) $('view-' + name).setAttribute('aria-pressed', String(view === name));
  $('view-diff').disabled = !differs() || !diffable;
  $('view-shared').disabled = !differs();

  if (view === 'diff') {
    $('diff-lines').replaceChildren(...renderDiffLines(diffLines(state.ours, state.remote)));
  } else {
    const text = view === 'shared' ? state.remote : state.ours;
    // Only when it actually changes, or the caret would jump to the end mid-typing.
    if ($('box').value !== text) $('box').value = text;
  }
  $('box').hidden = view === 'diff';
  $('diff-view').hidden = view !== 'diff';
  syncSave();
}

function renderBox() {
  renderMeta();
  renderFiles();
  renderView();
}

function setView(name) {
  view = name;
  renderView();
}

// Joined rather than reduced to items[0]: a record written by another client may hold
// more than one item, and dropping the rest would silently lose text.
const textOf = (items) => items.map((item) => item.text).join('\n');

function load(text, files, from, mine = false) {
  state.ours = text;
  state.remote = text;
  state.files = files;
  state.from = from || '';
  state.mine = mine;
  view = 'local';
  renderBox();
}

for (const name of VIEWS) $('view-' + name).addEventListener('click', () => setView(name));

$('box').addEventListener('input', () => {
  state.ours = $('box').value;
  // The moment Shared is edited it becomes ours: same textarea, same caret, other view lit.
  if (view === 'shared') view = 'local';
  renderView();
});

// --- refresh ----------------------------------------------------------------

// visibilitychange and focus both fire when you switch back to the tab, and a habit of
// alt-tabbing should not spend the room's rate limit.
const REFRESH_DEBOUNCE_MS = 2000;
let lastRefresh = 0;

const isMine = (result) => !!state.deviceId && result.dev === state.deviceId;

async function refresh(quiet) {
  if (!state.roomKey) return;
  const now = Date.now();
  if (quiet && now - lastRefresh < REFRESH_DEBOUNCE_MS) return;
  lastRefresh = now;
  try {
    const result = await fetchText(state);
    if (result.kind === 'rollback') {
      setStatus('main-status', 'ignored an older version', true);
      return;
    }
    if (result.kind === 'undecryptable') {
      // The box is the user's text as much as the room's, so it is not thrown away
      // because this end cannot read what the other end wrote.
      setStatus('main-status', 'cannot decrypt — different code?', true);
      return;
    }
    if (!quiet) setStatus('main-status', '');
    // Nothing the server says ever touches ours: it lands in remote, and the user picks
    // between the two with the switcher.
    if (result.kind === 'empty') {
      state.ts = 0;
      state.remote = '';
      state.files = [];
      state.from = '';
      state.mine = false;
      renderBox();
      return;
    }
    const text = textOf(result.items);
    const previous = state.remote;
    state.ts = result.ts;
    // With no version of our own there is nothing to protect or compare: just take it.
    // That covers the first record this tab loads.
    if (!state.ours && !state.remote) {
      load(text, result.files, result.from, isMine(result));
      return;
    }
    state.remote = text;
    state.files = result.files;
    state.from = result.from;
    state.mine = isMine(result);
    // A newer version opens straight in the diff, even mid-typing: otherwise nothing
    // shows that it came. What was typed is already in ours.
    if (text !== previous && differs()) view = 'diff';
    renderBox();
  } catch (err) {
    setStatus('main-status', reason(err), true);
  }
}

$('btn-pull').addEventListener('click', () => refresh(false));

// --- save and files ---------------------------------------------------------

// Exactly what sendText puts in the record, so the local echo matches what peers see.
const ownOrigin = () => origin(state.deviceName, describeAgent());

// Always ours, whichever view is showing: Save is disabled on an untouched Shared anyway.
$('btn-save').addEventListener('click', async () => {
  const items = parseItems(state.ours);
  $('btn-save').disabled = true;
  setStatus('main-status', '');
  try {
    if (items.length || state.files.length) {
      await sendText(state, state.files, items);
      // The text actually sent, so a trailing newline cannot leave the box dirty
      // against a value the server never saw. The button greying out is the receipt;
      // there is nothing to announce.
      state.ts = Date.now();
      load(items.length ? items[0].text : '', state.files, ownOrigin(), true);
    } else {
      // Nothing left to share at all: drop the room, attachments and seq floors with it.
      await api('/api/clear', { room: room(state) });
      state.seqs = {};
      state.ts = 0;
      await saveState();
      load('', [], '');
    }
  } catch (err) {
    setStatus('main-status', reason(err), true);
  } finally {
    syncSave();
  }
});

// Lowest free slot, so removing the middle file does not strand the numbering.
function freeSlot() {
  const taken = new Set(state.files.map((file) => file.slot));
  for (let slot = 1; slot <= MAX_FILES; slot++) if (!taken.has(slot)) return slot;
  return null;
}

// The manifest is written with state.remote rather than the box: attaching a file must
// not publish text the user has not chosen to save yet. Slot 0 is then this device's
// record, written just now, and the meta line says so.
async function saveManifest(files) {
  await sendText(state, files, parseItems(state.remote));
  state.files = files;
  state.ts = Date.now();
  state.from = ownOrigin();
  state.mine = true;
  renderBox();
}

$('btn-attach').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async () => {
  const chosen = [...$('file-input').files];
  // Cleared first: picking the same file twice in a row must still fire a change event.
  $('file-input').value = '';
  setStatus('main-status', '');

  for (const file of chosen) {
    if (state.files.length >= MAX_FILES) {
      setStatus('main-status', 'at most ' + MAX_FILES + ' files', true);
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus('main-status', 'file too large — ' + humanSize(MAX_FILE_BYTES) + ' max', true);
      continue;
    }
    const slot = freeSlot();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Bytes first, manifest second: a manifest is never allowed to name a slot that
      // does not exist yet. The reverse order would show a peer a broken download.
      await send(state, slot, bytes);
      await saveManifest([...state.files,
        { slot, name: safeName(file.name), type: file.type || '', size: file.size }]);
    } catch (err) {
      setStatus('main-status', reason(err), true);
      break;
    }
  }
});

async function removeFile(file) {
  try {
    // Manifest first here, for the same reason: no window where it names a dead slot.
    await saveManifest(state.files.filter((other) => other.slot !== file.slot));
    await api('/api/clear', { room: room(state), slot: file.slot });
    delete state.seqs[file.slot];
    await saveState();
  } catch (err) {
    setStatus('main-status', reason(err), true);
  }
}

// Revoked a while after the click rather than at once: the browser may still be starting
// the download from the URL.
const REVOKE_DELAY_MS = 10_000;

async function downloadFile(file) {
  setStatus('main-status', '');
  try {
    const result = await fetchRecord(state, file.slot);
    if (result.kind !== 'ok') {
      setStatus('main-status',
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
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  } catch (err) {
    setStatus('main-status', reason(err), true);
  }
}

// --- pairing ----------------------------------------------------------------

const DEVICE_ID_BYTES = 16;
const newDeviceId = () => b64u(crypto.getRandomValues(new Uint8Array(DEVICE_ID_BYTES)));

async function activate(code, persist) {
  const keys = await derive(code);
  state.roomKey = keys.roomKey;
  state.encKey = keys.encKey;
  state.persist = persist;
  state.deviceId = newDeviceId();
  state.seqs = {};
  state.remote = '';
  state.ours = '';
  state.files = [];
  if (persist) {
    await saveState();
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch { /* best effort */ }
    }
  }
  setRoot('main');
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
  // Before the settings: whether they apply at all depends on it.
  state.persist = true;
  applySettings(saved);
  state.deviceId = typeof saved.deviceId === 'string' && saved.deviceId ? saved.deviceId : '';
  // Records saved before the id existed get one now, once.
  if (!state.deviceId) {
    state.deviceId = newDeviceId();
    await saveState();
  }
  setRoot('main');
  load('', [], '');
  schedulePolling();
  await refresh(true);
  return true;
}

let pendingCode = null;
let pendingIsRotation = false;

const pairingLink = (code) => location.origin + '/#' + code;

// The four-module quiet zone the QR spec requires around the code.
const QR_QUIET = 4;

// One <path> rather than a rect per module, and a viewBox that carries the quiet zone.
function renderQr(host, text) {
  host.textContent = '';
  const code = qrMatrix(text);
  // Too long for version 6: no QR at all rather than an unreadable one.
  host.hidden = !code;
  if (!code) return;

  const NS = 'http://www.w3.org/2000/svg';
  const side = code.size + 2 * QR_QUIET;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-QR_QUIET} ${-QR_QUIET} ${side} ${side}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Pairing link as a QR code');

  const background = document.createElementNS(NS, 'rect');
  background.setAttribute('x', -QR_QUIET);
  background.setAttribute('y', -QR_QUIET);
  background.setAttribute('width', side);
  background.setAttribute('height', side);
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

function showCreated(code, isRotation) {
  pendingCode = code;
  pendingIsRotation = isRotation;
  $('new-code').textContent = grouped(code);
  renderQr($('qr'), pairingLink(code));
  $('btn-copy-code').textContent = 'Copy code';
  $('btn-copy-link').textContent = 'Copy link';
  setStatus('created-status', '');
  goTo('created');
}

$('btn-create').addEventListener('click', async () => {
  showCreated(await newCode(), false);
});

$('btn-repair').addEventListener('click', async () => {
  showCreated(await newCode(), true);
});

$('btn-have').addEventListener('click', () => {
  setStatus('enter-status', '');
  $('code-input').value = '';
  goTo('enter');
  $('code-input').focus();
});

$('btn-copy-code').addEventListener('click', async () => {
  const copied = await copyNow(grouped(pendingCode));
  $('btn-copy-code').textContent = copied ? 'Copied' : 'Select it manually';
});

$('btn-copy-link').addEventListener('click', async () => {
  const copied = await copyNow(pairingLink(pendingCode));
  $('btn-copy-link').textContent = copied ? 'Copied' : 'Select it manually';
});

$('btn-created-go').addEventListener('click', async () => {
  // Taken before activate() replaces the key it comes from.
  const oldRoom = pendingIsRotation && state.roomKey ? room(state) : null;
  try {
    // The new room first, so a failure here leaves the device on the old one, intact.
    await activate(pendingCode, true);
  } catch {
    setStatus('created-status', 'Could not set up this device.', true);
    return;
  }
  // activate() has saved the new keys over the old ones; what is left of the old room
  // is on the server.
  if (oldRoom) {
    try { await api('/api/clear', { room: oldRoom }); } catch { /* old room may be gone */ }
  }
});

$('btn-enter-back').addEventListener('click', () => history.back());

$('btn-enter-go').addEventListener('click', async () => {
  const code = await normalize($('code-input').value);
  if (!code) {
    setStatus('enter-status', 'That code does not look right — check for a typo.', true);
    return;
  }
  setStatus('enter-status', '');
  try {
    await activate(code, $('chk-remember').checked);
  } catch {
    setStatus('enter-status', 'Could not set up this device.', true);
  }
});

$('code-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('btn-enter-go').click();
});

$('btn-unlink').addEventListener('click', async () => {
  try { await api('/api/clear', { room: room(state) }); } catch { /* best effort */ }
  await wipeDevice();
  location.replace(location.origin + '/');
});

// --- settings ---------------------------------------------------------------

// The title a tab has before it is renamed; it doubles as the field's placeholder.
const DEFAULT_TITLE = document.title;

// The tab name belongs to one tab, hence sessionStorage rather than the device record:
// that one is shared by every tab on the origin, and two tabs would overwrite each
// other's names.
const TAB_NAME_KEY = 'tab-name';

// The field lives in Settings; the name itself shows only in the browser's tab title.
function applyName(name) {
  const field = $('tab-name');
  if (field.value !== name) field.value = name;
  field.placeholder = DEFAULT_TITLE;
  document.title = name || DEFAULT_TITLE;
}

applyName(tabStore.get(TAB_NAME_KEY) || '');

$('tab-name').addEventListener('input', () => {
  const name = $('tab-name').value.trim();
  document.title = name || DEFAULT_TITLE;
  tabStore.set(TAB_NAME_KEY, name);
});

$('tab-name').addEventListener('change', () => applyName($('tab-name').value.trim()));

$('tab-name').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('tab-name').blur();
});

// Device settings are one set for every tab on the origin, so they live in the device
// record rather than in sessionStorage, and reach the other open tabs over a
// BroadcastChannel.
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
  // On a work VM the device is not remembered, so there is nowhere to keep the setting
  // and polling never starts. That is a property of the code, not of the user's care.
  $('chk-auto').disabled = !state.persist;
  $('auto-note').textContent = state.persist
    ? 'Checks every ' + (POLL_MS / 1000) + ' seconds while this tab is in front.'
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
  return saveState();
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  goTo('settings');
});

$('btn-settings-back').addEventListener('click', () => history.back());

$('device-name').addEventListener('change', () => {
  state.deviceName = $('device-name').value.trim();
  saveSettings();
});

$('chk-auto').addEventListener('change', () => {
  state.autoRefresh = $('chk-auto').checked;
  saveSettings();
});

// --- card size --------------------------------------------------------------
// The textarea's own resize handle is off: the card is dragged by its own corner, and
// the field grows with it in both height and width. The size belongs to one tab, hence
// sessionStorage.

const CARD_HEIGHT_KEY = 'card-height';
const CARD_WIDTH_KEY = 'card-width';
const MIN_CARD_HEIGHT = 240;
const MIN_CARD_WIDTH = 360;
// --gutter in index.html: the card never grows past the page's side margins.
const GUTTER = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter'));
const DRAG_END = ['pointerup', 'pointercancel', 'lostpointercapture'];

const grip = $('grip');
const card = grip.parentElement;

// 0 means the default size. The card may be wider than main: align-self:center in the
// .screen column centres it even when it overflows, evenly on both sides.
function applyCardSize({ w, h }) {
  card.style.flex = h ? 'none' : '';
  card.style.height = h ? h + 'px' : '';
  card.style.width = w ? w + 'px' : '';
  card.style.alignSelf = w ? 'center' : '';
  card.style.maxWidth = w ? `calc(100vw - ${2 * GUTTER}px)` : '';
}

applyCardSize({
  w: Number(tabStore.get(CARD_WIDTH_KEY)) || 0,
  h: Number(tabStore.get(CARD_HEIGHT_KEY)) || 0,
});

grip.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  // Capture the pointer, or the drag breaks off the moment it leaves the grip.
  grip.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  const start = card.getBoundingClientRect();

  const onMove = (move) => {
    const h = Math.max(MIN_CARD_HEIGHT, Math.round(start.height + move.clientY - startY));
    // The card grows from its centre, hence ×2: otherwise the corner lags the pointer.
    const w = Math.min(innerWidth - 2 * GUTTER,
      Math.max(MIN_CARD_WIDTH, Math.round(start.width + 2 * (move.clientX - startX))));
    applyCardSize({ w, h });
  };
  // A drag normally ends with pointerup, but the browser can also take the pointer away
  // (pointercancel, lostpointercapture). Whichever comes first finishes it, once.
  const finish = () => {
    grip.removeEventListener('pointermove', onMove);
    for (const type of DRAG_END) grip.removeEventListener(type, finish);
    const size = card.getBoundingClientRect();
    tabStore.set(CARD_HEIGHT_KEY, String(Math.round(size.height)));
    tabStore.set(CARD_WIDTH_KEY, String(Math.round(size.width)));
  };
  grip.addEventListener('pointermove', onMove);
  for (const type of DRAG_END) grip.addEventListener(type, finish);
});

// A double-click returns the card to its default size.
grip.addEventListener('dblclick', () => {
  applyCardSize({ w: 0, h: 0 });
  tabStore.set(CARD_HEIGHT_KEY, '');
  tabStore.set(CARD_WIDTH_KEY, '');
});

// --- phone keyboard ---------------------------------------------------------
// iOS shrinks neither dvh nor the page for the keyboard, only the visible part of it:
// main's height is fitted to that, or the buttons slide under the keyboard. On Android
// interactive-widget=resizes-content in the viewport does the same, and this height
// simply agrees with it.

if (window.visualViewport) {
  let fittedHeight = 0;
  const fitViewport = () => {
    // Pinch-zoom resizes the visual viewport too, but only the keyboard should resize
    // the page.
    if (visualViewport.scale !== 1 || visualViewport.height === fittedHeight) return;
    fittedHeight = visualViewport.height;
    document.documentElement.style.setProperty('--app-h', fittedHeight + 'px');
    // Focusing a field scrolls the page down even when everything already fits. Undo
    // that only when it does fit, so a focused field is never scrolled out of view.
    if (document.documentElement.scrollHeight <= Math.ceil(fittedHeight)) window.scrollTo(0, 0);
  };
  visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}

// --- polling ----------------------------------------------------------------

const POLL_MS = 10_000;
let pollTimer = null;

// Only with a remembered device, and only while the tab is in front: a dozen background
// tabs would otherwise eat the room's rate limit (120 requests per 10 minutes).
function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!state.autoRefresh || !state.persist || !state.roomKey) return;
  if (document.visibilityState !== 'visible') return;
  pollTimer = setInterval(() => refresh(true), POLL_MS);
}

// "5 min ago" goes stale while the page sits open. A cheap local tick keeps it true
// while the main screen is in front; it costs no requests.
const AGO_TICK_MS = 30_000;
let agoTimer = null;

function scheduleAgo() {
  clearInterval(agoTimer);
  agoTimer = null;
  if (currentScreen !== 'main' || document.visibilityState !== 'visible') return;
  renderMeta();
  agoTimer = setInterval(renderMeta, AGO_TICK_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomKey) refresh(true);
  schedulePolling();
  scheduleAgo();
});

window.addEventListener('focus', () => {
  if (state.roomKey) refresh(true);
});

// --- menu -------------------------------------------------------------------

function setMenu(open) {
  $('menu').hidden = !open;
  $('btn-menu').setAttribute('aria-expanded', String(open));
}

$('btn-menu').addEventListener('click', () => setMenu($('menu').hidden));
// The items do their work in their own handlers; the click reaches here after them.
$('menu').addEventListener('click', () => setMenu(false));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu-host')) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('menu').hidden) {
    setMenu(false);
    $('btn-menu').focus();
  }
});

// --- boot -------------------------------------------------------------------

// iOS Safari applies :active styles only once some touch listener exists; a passive
// no-op is enough.
document.addEventListener('touchstart', () => {}, { passive: true });

(async () => {
  if (!crypto || !crypto.subtle) {
    // Either the page is not on HTTPS, or policy has disabled WebCrypto. Encrypting
    // in the browser is the whole design, so there is no degraded mode to offer.
    $('pair-note').textContent = 'This browser will not let the page encrypt anything, '
      + 'so it cannot be used here. That usually means the site was opened over plain '
      + 'HTTP rather than HTTPS.';
    $('btn-create').disabled = true;
    $('btn-have').disabled = true;
    setRoot('pair');
    return;
  }

  const fromLink = location.hash ? await normalize(location.hash.slice(1)) : null;
  if (fromLink) {
    // Strip it before anything else can read it back off the address bar.
    history.replaceState(null, '', location.pathname);
    try {
      await activate(fromLink, true);
      return;
    } catch { /* fall through to the pairing screen */ }
  }

  if (await resume()) return;
  setRoot('pair');
})();

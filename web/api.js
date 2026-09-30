// Talking to the server: seal, send, fetch, open.
//
// Slot 0 holds the text and the list of attachments, slots 1..MAX_FILES one file each.
// The module deliberately knows nothing of state or the DOM: keys and slots arrive as
// parameters, or the import of app.js would go round in a circle.

import { DEC, ENC, b64u, seal, unb64u, unseal } from './crypto.js';
import { describeAgent } from './agent.js';

export const TEXT_SLOT = 0;
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 1024 * 1024;
export const FROM_MAX = 64;
const DEVICE_ID_MAX = 32;
const FILE_NAME_MAX = 120;

export async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch { /* not JSON: nothing more to report */ }
  if (!response.ok) {
    const error = new Error((data && data.error) || ('HTTP ' + response.status));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const room = (session) => b64u(session.roomKey);

// Rollback floors are per slot: one counter shared across slots would race ahead on the
// text and then trip the server's jump limit the first time a rarely-written file slot
// is used.
const seqOf = (session, slot) => session.seqs[slot] || 0;

async function pushRecord(session, slot, plaintext) {
  const seq = seqOf(session, slot) + 1;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await seal(session.encKey, session.roomKey, slot, seq, iv, plaintext);
  await api('/api/put',
    { room: room(session), slot, seq, iv: b64u(iv), ct: b64u(ciphertext) });
  session.seqs[slot] = seq;
  await session.save();
}

export async function send(session, slot, plaintext) {
  try {
    await pushRecord(session, slot, plaintext);
  } catch (err) {
    // Another device wrote while we were away; adopt its sequence and try once more.
    if (err.status === 409 && err.data && typeof err.data.seq === 'number') {
      session.seqs[slot] = err.data.seq;
      await pushRecord(session, slot, plaintext);
    } else {
      throw err;
    }
  }
}

// "My laptop · Chrome/Windows", or just one half when the other is missing. The length is
// capped here too: the string ends up in the card header on the other side.
export function origin(deviceName, agent) {
  return [deviceName, agent]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' · ')
    .slice(0, FROM_MAX);
}

// Slot 0 carries the text and the manifest together, so a peer learns about an
// attachment in the same fetch that brings it the text.
export const sendText = (session, files, items) =>
  send(session, TEXT_SLOT, ENC.encode(JSON.stringify({
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    items,
    files,
    from: origin(session.deviceName, describeAgent()),
    // Random per device, so a record can be recognised as our own even when another
    // device has the same browser, platform and (empty) name.
    dev: session.deviceId,
  })));

export async function fetchRecord(session, slot) {
  const record = await api('/api/get', { room: room(session), slot });
  if (!record) {
    // The slot is empty: cleared, or expired. Drop the rollback floor with it, so a
    // peer that did not do the clearing is not stuck rejecting the next send.
    if (session.seqs[slot]) {
      delete session.seqs[slot];
      await session.save();
    }
    return { kind: 'empty' };
  }
  if (record.seq < seqOf(session, slot)) return { kind: 'rollback' };

  let plaintext;
  try {
    plaintext = await unseal(session.encKey, session.roomKey, slot, record.seq,
      unb64u(record.iv), unb64u(record.ct));
  } catch {
    return { kind: 'undecryptable' };
  }

  session.seqs[slot] = record.seq;
  await session.save();
  return { kind: 'ok', plaintext };
}

// Slot 0 only: the file slots hold raw bytes and are never parsed as JSON.
export async function fetchText(session) {
  const result = await fetchRecord(session, TEXT_SLOT);
  if (result.kind !== 'ok') return result;

  let payload;
  try {
    payload = JSON.parse(DEC.decode(result.plaintext));
  } catch {
    return { kind: 'undecryptable' };
  }
  // It opened, so it came from someone holding the code, but not necessarily from this
  // client: anything that is not an object is as unreadable as a bad tag.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'undecryptable' };
  }
  const items = Array.isArray(payload.items)
    ? payload.items.filter((item) => item && typeof item.text === 'string')
    : [];
  return {
    kind: 'ok',
    items,
    files: validFiles(payload.files),
    from: cleanString(payload.from, FROM_MAX),
    dev: cleanString(payload.dev, DEVICE_ID_MAX),
    ts: Number.isFinite(payload.ts) && payload.ts > 0 ? payload.ts * 1000 : 0,
  };
}

// A string from another device ends up in the markup and could be anything: cap its
// length and blank out control characters, so it cannot stretch or break the line.
const cleanString = (value, max) => (typeof value === 'string'
  ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

// A name travels from another device and ends up in a download attribute: keep it to one
// harmless path segment.
export const safeName = (name) =>
  name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, FILE_NAME_MAX) || 'file';

// Whatever a peer put in the manifest, only entries this client can act on survive:
// a usable slot of its own, a name to show, and a size it could have sent.
function validFiles(files) {
  if (!Array.isArray(files)) return [];
  const slots = new Set();
  const valid = [];
  for (const file of files) {
    if (!file
      || !Number.isInteger(file.slot) || file.slot < 1 || file.slot > MAX_FILES
      || slots.has(file.slot)
      || typeof file.name !== 'string' || file.name.length === 0
      || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) continue;
    slots.add(file.slot);
    valid.push({
      slot: file.slot,
      name: safeName(file.name),
      type: typeof file.type === 'string' ? file.type : '',
      size: file.size,
    });
  }
  return valid;
}

// The whole box is one value: line breaks are part of what you sent, not a separator.
// The empty label keeps the record shape {v, ts, items:[{label, text}]} unchanged.
export function parseItems(text) {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return [];
  return [{ label: '', text: trimmed }];
}

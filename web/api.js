// Разговор с сервером: запечатать, отправить, забрать, расшифровать.
//
// Слот 0 хранит текст и перечень вложений, слоты 1..MAX_FILES — по файлу в каждом.
// Модуль намеренно не знает про state и DOM: ключи и слот приходят параметрами, иначе
// получился бы круговой импорт с app.js.

import { DEC, ENC, aad, b64u, seal, unb64u, unseal } from './crypto.js';
import { describeAgent } from './agent.js';

export const TEXT_SLOT = 0;
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 1024 * 1024;

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
  try { data = await response.json(); } catch (err) { data = null; }
  if (!response.ok) {
    const error = new Error((data && data.error) || ('HTTP ' + response.status));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

const room = (session) => b64u(session.roomKey);

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

// Slot 0 carries the text and the manifest together, so a peer learns about an
// attachment in the same fetch that brings it the text.
// «Мой ноутбук · Chrome on Windows», или только одна половина, если второй нет. Длина
// ограничена здесь же: строка попадает в заголовок карточки на той стороне.
export function origin(deviceName, agent) {
  return [deviceName, agent]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' · ')
    .slice(0, FROM_MAX);
}

export const sendText = (session, text, files, items) =>
  send(session, TEXT_SLOT, ENC.encode(JSON.stringify({
    v: 1, ts: Math.floor(Date.now() / 1000), items, files,
    from: origin(session.deviceName, describeAgent()),
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
  } catch (err) {
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
  } catch (err) {
    return { kind: 'undecryptable' };
  }
  const items = Array.isArray(payload && payload.items) ? payload.items.filter(
    (item) => item && typeof item.text === 'string') : [];
  return { kind: 'ok', items, files: validFiles(payload && payload.files),
    from: validFrom(payload && payload.from), ts: (payload.ts || 0) * 1000 };
}

// Строка приходит от другого устройства, попадает в разметку и может быть любой:
// режем длину и управляющие символы, чтобы она не растянула строку и не съехала.
export const FROM_MAX = 64;
const validFrom = (from) => (typeof from === 'string'
  ? from.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, FROM_MAX) : '');

// Whatever a peer put in the manifest, only entries this client can act on survive:
// a usable slot, a name to show, and a size to display.
function validFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => file
    && Number.isInteger(file.slot) && file.slot >= 1 && file.slot <= MAX_FILES
    && typeof file.name === 'string' && file.name.length > 0
    && Number.isFinite(file.size))
    .slice(0, MAX_FILES)
    .map((file) => ({
      slot: file.slot,
      name: file.name,
      type: typeof file.type === 'string' ? file.type : '',
      size: file.size,
    }));
}

// The whole box is one value: line breaks are part of what you sent, not a separator.
// The empty label keeps the record shape {v, ts, items:[{label, text}]} unchanged.
export function parseItems(text) {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return [];
  return [{ label: '', text: trimmed }];
}

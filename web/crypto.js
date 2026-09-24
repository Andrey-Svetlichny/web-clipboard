// Ключи и запечатывание записей. Второй, независимой реализацией этого же служит
// tests/reference.mjs — вектора сверяют их друг с другом.

export const ENC = new TextEncoder();
export const DEC = new TextDecoder();

const SALT = ENC.encode('web-clipboard/v1');
const INFO_ROOM = ENC.encode('web-clipboard/v1 r');
const INFO_KEY = ENC.encode('web-clipboard/v1 k');

export function b64u(bytes) {
  let binary = '';
  // In chunks: one append per byte is fine for a 12-byte IV and painful for a 1 MiB file.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function derive(code) {
  const base = await crypto.subtle.importKey(
    'raw', ENC.encode(code), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const roomKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO_ROOM }, base, 128));
  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO_KEY }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { roomKey, encKey };
}

// roomKey || slot (4 bytes BE) || seq (8 bytes BE). The slot is in here because without
// it a file record could be lifted into another slot of the same room at the same
// sequence number and would still open.
export function aad(roomKey, slot, seq) {
  const out = new Uint8Array(roomKey.length + 12);
  out.set(roomKey, 0);
  const view = new DataView(out.buffer);
  view.setUint32(roomKey.length, slot, false);
  view.setBigUint64(roomKey.length + 4, BigInt(seq), false);
  return out;
}

export async function seal(encKey, roomKey, slot, seq, iv, plaintext) {
  return new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(roomKey, slot, seq) }, encKey, plaintext));
}

export async function unseal(encKey, roomKey, slot, seq, iv, ciphertext) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad(roomKey, slot, seq) }, encKey, ciphertext));
}

// An independent implementation of spec.md, used only by the tests.
//
// It deliberately shares nothing with the client: HKDF is expanded by hand from RFC
// 5869 rather than called through WebCrypto, and AES-GCM goes through node:crypto's
// cipher API rather than crypto.subtle. If the two agree byte for byte, the spec is
// unambiguous and neither side has drifted.

import { createDecipheriv, createHash, createHmac } from 'node:crypto';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LEN = 20;
export const BODY_LEN = 19;

const SALT = Buffer.from('web-clipboard/v1');
const INFO_ROOM = Buffer.from('web-clipboard/v1 r');
const INFO_KEY = Buffer.from('web-clipboard/v1 k');

export function hkdf(ikm, salt, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const blocks = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

export function checkChar(body) {
  return ALPHABET[createHash('sha256').update(body, 'utf8').digest()[0] & 0x1f];
}

export function normalize(text) {
  const cleaned = String(text).toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LEN) return null;
  for (const character of cleaned) if (!ALPHABET.includes(character)) return null;
  return cleaned[BODY_LEN] === checkChar(cleaned.slice(0, BODY_LEN)) ? cleaned : null;
}

export function derive(code) {
  const ikm = Buffer.from(code, 'utf8');
  return {
    roomKey: hkdf(ikm, SALT, INFO_ROOM, 16),
    encKey: hkdf(ikm, SALT, INFO_KEY, 32),
  };
}

// roomKey || slot (4 bytes BE) || seq (8 bytes BE).
export function aad(roomKey, slot, seq) {
  const suffix = Buffer.alloc(12);
  suffix.writeUInt32BE(slot, 0);
  suffix.writeBigUInt64BE(BigInt(seq), 4);
  return Buffer.concat([Buffer.from(roomKey), suffix]);
}

// WebCrypto appends the 16-byte tag to the ciphertext; node:crypto wants it separately.
export function open(encKey, roomKey, slot, seq, iv, sealed) {
  const body = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAAD(aad(roomKey, slot, seq));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

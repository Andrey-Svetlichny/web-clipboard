// The pairing code: Crockford's alphabet, a check character, and parsing what a person
// typed by hand. The details are in spec.md; both sides must agree character for character.

import { ENC, sha256 } from './crypto.js';

// Crockford base 32: no I, L or O, which read as 1 and 0 and are folded into them when
// typed, and no U, which has no look-alike to fold, so a typed U is simply rejected.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 20;
// 19 characters × 5 bits = 95 bits of secret; the twentieth is the check character.
const BODY_LEN = 19;

export async function checkChar(body) {
  const digest = await sha256(ENC.encode(body));
  return ALPHABET[digest[0] & 0x1f];
}

export async function newCode() {
  // 256 is a multiple of 32, so a plain modulo is already uniform here.
  const random = crypto.getRandomValues(new Uint8Array(BODY_LEN));
  let body = '';
  for (const value of random) body += ALPHABET[value % 32];
  return body + await checkChar(body);
}

export async function normalize(input) {
  const cleaned = String(input).toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LEN) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  const body = cleaned.slice(0, BODY_LEN);
  return cleaned[BODY_LEN] === await checkChar(body) ? cleaned : null;
}

export function grouped(code) {
  return code.replace(/(.{5})(?=.)/g, '$1-');
}

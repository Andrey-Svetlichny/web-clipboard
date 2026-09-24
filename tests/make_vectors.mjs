// Emits tests/vectors.json by running the very modules the browser loads.
// Node >= 18. Usage: node tests/make_vectors.mjs [outfile]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as codes from '../web/code.js';
import * as sealing from '../web/crypto.js';
import { parseItems } from '../web/api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = { ...codes, ...sealing, parseItems };

const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const BODIES = [
  '0123456789ABCDEFGHJ',
  'ZZZZZZZZZZZZZZZZZZZ',
  '00000000000000000000'.slice(0, 19),
  'KMNPQRSTVWXYZ0123AB',
];

const PLAINTEXTS = [
  '{"v":1,"ts":1757808000,"items":[{"label":"IBAN","text":"DE89370400440532013000"}]}',
  '{"v":1,"ts":1,"items":[{"label":"","text":"p\\u00e4sswörd — 🔑"}]}',
];

const vectors = { codes: [], records: [], normalize: [], parse: [] };

for (const body of BODIES) {
  const code = body + await core.checkChar(body);
  const keys = await core.derive(code);
  vectors.codes.push({ body, code, room_key: hex(keys.roomKey) });

  for (const [index, text] of PLAINTEXTS.entries()) {
    const seq = index === 0 ? 1 : 4096;
    // Slot 1 as well as slot 0, so the vectors pin the slot's place in the AAD: the
    // same code, sequence and iv must produce different ciphertext per slot.
    const slot = index === 0 ? 0 : 1;
    const iv = new Uint8Array(12).map((_, i) => (i * 17 + index * 5 + body.length) & 0xff);
    const ct = await core.seal(keys.encKey, keys.roomKey, slot, seq, iv, encoder.encode(text));
    vectors.records.push({
      code, slot, seq, iv: hex(iv), plaintext: text, ct: hex(ct),
      aad: hex(core.aad(keys.roomKey, slot, seq)),
    });
  }
}

const canonical = BODIES[0] + await core.checkChar(BODIES[0]);
const typed = [
  canonical,
  canonical.toLowerCase(),
  canonical.replace(/(.{5})(?=.)/g, '$1-'),
  '  ' + canonical.split('').join(' ') + '  ',
  canonical.replace(/0/g, 'O').replace(/1/g, 'I'),
  canonical.replace(/0/g, 'o').replace(/1/g, 'l'),
  canonical.slice(0, 19),                                   // too short
  canonical + 'Z',                                          // too long
  canonical.slice(0, 19) + (canonical[19] === 'Z' ? '0' : 'Z'),  // bad checksum
  canonical.slice(0, 18) + 'UU',                            // U is not in the alphabet
];
for (const input of typed) {
  vectors.normalize.push({ input, output: await core.normalize(input) });
}

const PARSE_CASES = [
  'IBAN: DE89 3704 0044 0532 0130 00\nBIC: COBADEFFXXX\nhunter2',
  'https://example.com/x\n\n  spaced   \n',
  'line one\nline two',
  'Ref no.: 99\nA: b',
];
for (const text of PARSE_CASES) {
  vectors.parse.push({ text, items: core.parseItems(text) });
}

const out = process.argv[2] || path.join(root, 'tests', 'vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`${out}: ${vectors.codes.length} codes, ${vectors.records.length} records`);

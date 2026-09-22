// Emits tests/vectors.json by running the crypto core out of web/index.html itself.
// Node >= 18. Usage: node tests/make_vectors.mjs [outfile]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

const block = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!block) throw new Error('no inline <script> block in web/index.html');

// document is undefined here, so the page script exports its core and stops before
// touching the DOM. See the "test hook" section in index.html.
new Function(block[1])();
const core = globalThis.__clipboardCore;
if (!core) throw new Error('index.html did not export its core — test hook missing?');

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
    const iv = new Uint8Array(12).map((_, i) => (i * 17 + index * 5 + body.length) & 0xff);
    const ct = await core.seal(keys.encKey, keys.roomKey, seq, iv, encoder.encode(text));
    vectors.records.push({
      code, seq, iv: hex(iv), plaintext: text, ct: hex(ct),
      aad: hex(core.aad(keys.roomKey, seq)),
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

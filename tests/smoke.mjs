// End-to-end smoke test against a running server, driving the crypto core straight
// out of web/index.html. Usage: node tests/smoke.mjs [base-url]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
new Function(/<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1])();
const core = globalThis.__noteCore;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let failures = 0;

function check(label, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
}

async function api(endpoint, body) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return { status: 204, data: null };
  return { status: response.status, data: await response.json().catch(() => null) };
}

// A code the way the phone would make one, then the VM typing it back in badly.
const code = await core.newCode();
const typed = core.grouped(code).toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l');
const recovered = await core.normalize(typed);
check('a mistyped-but-equivalent code normalises back', recovered === code, typed);

const keys = await core.derive(code);
const room = core.b64u(keys.roomKey);

check('room starts empty', (await api('get', { room })).status === 204);

const items = core.parseItems('IBAN: DE89370400440532013000\nBIC: COBADEFFXXX\nhunter2', false);
check('three lines parse into three items', items.length === 3,
  JSON.stringify(items.map((i) => i.label)));

const seq = 1;
const iv = crypto.getRandomValues(new Uint8Array(12));
const plaintext = encoder.encode(JSON.stringify({ v: 1, ts: Math.floor(Date.now() / 1000), items }));
const ct = await core.seal(keys.encKey, keys.roomKey, seq, iv, plaintext);

const put = await api('put', { room, seq, iv: core.b64u(iv), ct: core.b64u(ct) });
check('put accepted', put.status === 200, JSON.stringify(put.data));

const got = await api('get', { room });
check('get returns the record', got.status === 200 && got.data.seq === seq);

const opened = await core.unseal(
  keys.encKey, keys.roomKey, got.data.seq, core.unb64u(got.data.iv), core.unb64u(got.data.ct));
const payload = JSON.parse(decoder.decode(opened));
check('round trip preserves every value',
  JSON.stringify(payload.items) === JSON.stringify(items));

// The tag must be bound to the sequence number.
let tampered = false;
try {
  await core.unseal(keys.encKey, keys.roomKey, seq + 1,
    core.unb64u(got.data.iv), core.unb64u(got.data.ct));
} catch (err) {
  tampered = true;
}
check('a record cannot be replayed at another sequence', tampered);

check('replaying the same seq is refused', (await api('put',
  { room, seq, iv: core.b64u(iv), ct: core.b64u(ct) })).status === 409);
check('a sequence jump is refused', (await api('put',
  { room, seq: 2 ** 40, iv: core.b64u(iv), ct: core.b64u(ct) })).status === 409);

check('clear works', (await api('clear', { room })).status === 200);
check('room is empty again', (await api('get', { room })).status === 204);

const page = await fetch(`${base}/`);
const csp = page.headers.get('content-security-policy') || '';
check('page ships a hash-based CSP with no unsafe-inline',
  csp.includes("script-src 'sha256-") && !csp.includes('unsafe-inline'));

process.exit(failures ? 1 : 0);

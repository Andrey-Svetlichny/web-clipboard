import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp, MAX_BODY, MAX_CT, MAX_SLOT } from '../server/index.mjs';

const ROOM = Buffer.alloc(16, 0x07).toString('base64url');
const IV = Buffer.alloc(12, 0x00).toString('base64url');
const CT = Buffer.alloc(40, 0x09).toString('base64url');
const TEXT = 0;
const FILE = 1;

async function withApp(t, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-api-'));
  const app = createApp({ dbPath: path.join(dir, 'api.db') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const post = (endpoint, body) => fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  try {
    await run({ app, base, post });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('an empty room answers 204', (t) => withApp(t, async ({ post }) => {
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 204);
}));

test('put then get', (t) => withApp(t, async ({ post }) => {
  assert.deepEqual(await (await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT })).json(),
    { seq: 1 });
  assert.deepEqual(await (await post('get', { room: ROOM, slot: TEXT })).json(),
    { seq: 1, iv: IV, ct: CT });
}));

test('a stale sequence is 409 and reports the current one', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 3, iv: IV, ct: CT });
  const response = await post('put', { room: ROOM, slot: TEXT, seq: 2, iv: IV, ct: CT });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).seq, 3);
}));

test('a sequence jump is refused', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('put', { room: ROOM, slot: TEXT, seq: 2 ** 40, iv: IV, ct: CT })).status, 409);
}));

test('clear empties the room and lets it restart', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('clear', { room: ROOM, slot: TEXT })).status, 200);
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 204);
  assert.equal((await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT })).status, 200);
}));

test('malformed requests are rejected', (t) => withApp(t, async ({ post }) => {
  const shortRoom = Buffer.alloc(8, 0x01).toString('base64url');
  const cases = [
    ['get', { room: shortRoom, slot: TEXT }],
    ['get', { room: 5, slot: TEXT }],
    ['get', {}],
    ['get', { room: `${ROOM.slice(0, -1)}!`, slot: TEXT }],
    ['get', '[1,2,3]'],
    ['get', 'not json'],
    ['put', { room: ROOM, slot: TEXT, seq: 0, iv: IV, ct: CT }],
    ['put', { room: ROOM, slot: TEXT, seq: 1.5, iv: IV, ct: CT }],
    ['put', { room: ROOM, slot: TEXT, seq: true, iv: IV, ct: CT }],
    ['put', { room: ROOM, slot: TEXT, seq: 1, iv: CT, ct: CT }],
    ['put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: 'AAAA' }],
    ['get', { room: ROOM }],
    ['get', { room: ROOM, slot: MAX_SLOT + 1 }],
    ['get', { room: ROOM, slot: -1 }],
    ['get', { room: ROOM, slot: 1.5 }],
    ['get', { room: ROOM, slot: '0' }],
    ['clear', { room: ROOM, slot: MAX_SLOT + 1 }],
  ];
  for (const [endpoint, body] of cases) {
    assert.equal((await post(endpoint, body)).status, 400, JSON.stringify(body));
  }
}));

test('a ciphertext over the limit is 413', (t) => withApp(t, async ({ post }) => {
  const oversized = Buffer.alloc(MAX_CT + 1).toString('base64url');
  assert.equal(
    (await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: oversized })).status, 413);
}));

test('a body over the limit is 413 before it is read', (t) => withApp(t, async ({ base }) => {
  // Declared, not sent: readBody must refuse on Content-Length alone, or a large upload
  // is buffered in full before anyone checks whether it was allowed.
  const response = await fetch(`${base}/api/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) },
    body: 'x'.repeat(MAX_BODY + 1),
  });
  assert.equal(response.status, 413);
}));

test('slots are stored apart and cleared apart', (t) => withApp(t, async ({ post }) => {
  const other = Buffer.alloc(40, 0x0a).toString('base64url');
  await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT });
  await post('put', { room: ROOM, slot: FILE, seq: 1, iv: IV, ct: other });
  assert.equal((await (await post('get', { room: ROOM, slot: FILE })).json()).ct, other);

  assert.equal((await post('clear', { room: ROOM, slot: FILE })).status, 200);
  assert.equal((await post('get', { room: ROOM, slot: FILE })).status, 204);
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 200);

  // No slot means the whole room, attachments included.
  await post('put', { room: ROOM, slot: FILE, seq: 1, iv: IV, ct: other });
  assert.equal((await post('clear', { room: ROOM })).status, 200);
  assert.equal((await post('get', { room: ROOM, slot: FILE })).status, 204);
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 204);
}));

test('the per-room rate limit bites', (t) => withApp(t, async ({ app, post }) => {
  const seen = new Set();
  for (let i = 0; i < app.roomLimiter.capacity + 10; i++) {
    seen.add((await post('get', { room: ROOM, slot: TEXT })).status);
  }
  assert.ok(seen.has(429), [...seen].join(','));
}));

test('the CSP still pins the inline style to its bytes', (t) => withApp(t, async ({ base }) => {
  // Catches the CRLF trap, and every future "edited the CSS and forgot". Scripts are
  // modules now and covered by 'self' instead; the style stays inline and stays hashed.
  const response = await fetch(`${base}/`);
  const csp = response.headers.get('content-security-policy');
  const text = Buffer.from(await response.arrayBuffer()).toString('binary');
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(text);
  const digest = createHash('sha256').update(Buffer.from(match[1], 'binary')).digest('base64');
  assert.ok(csp.includes(`style-src 'sha256-${digest}'`), csp);
  assert.ok(csp.includes("script-src 'self'"), csp);
  assert.equal(csp.includes('unsafe-inline'), false);
}));

test('modules are served, and only the ones that exist', (t) => withApp(t, async ({ base }) => {
  const response = await fetch(`${base}/app.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${base}/qr.js`)).status, 200);
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
}));

test('the page has no inline handlers or style attributes', (t) => withApp(t, async ({ base }) => {
  // Both are blocked by a hash-based CSP, and both fail silently in the browser.
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/\son[a-z]+\s*=/.test(body), false);
  assert.equal(/\sstyle\s*=/.test(body), false);
  // Ровно один <script>, и он без тела: код приходит модулями с того же домена.
  assert.equal(body.split('<script').length - 1, 1);
  assert.match(body, /<script type="module" src="\/app\.js"><\/script>/);
  assert.equal(body.split('<style').length - 1, 1);
}));

test('the page loads nothing from another origin', (t) => withApp(t, async ({ base }) => {
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/(src|href)\s*=\s*"(https?:)?\/\//.test(body), false);
}));

test('every element the script reaches for exists', (t) => withApp(t, async ({ base }) => {
  // A mistyped id throws at load time in the browser and nowhere else.
  const body = await (await fetch(`${base}/`)).text();
  const script = await (await fetch(`${base}/app.js`)).text();
  const wanted = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const present = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(wanted.size > 0);
  for (const id of wanted) assert.ok(present.has(id), `missing element #${id}`);

  const screens = new Set([...script.matchAll(/show\('([^']+)'\)/g)].map((m) => m[1]));
  const declared = new Set([...body.matchAll(/data-screen="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(screens.size > 0);
  for (const name of screens) assert.ok(declared.has(name), `missing screen ${name}`);
}));

test('security headers', (t) => withApp(t, async ({ base }) => {
  const headers = (await fetch(`${base}/`)).headers;
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('cache-control'), 'no-store');
}));

test('icons and manifest are served, unknown paths are not', (t) => withApp(t, async ({ base }) => {
  assert.equal((await fetch(`${base}/icon-192.png`)).status, 200);
  assert.equal((await fetch(`${base}/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/../server/index.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
}));

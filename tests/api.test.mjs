import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../server/index.mjs';

const ROOM = Buffer.alloc(16, 0x07).toString('base64url');
const IV = Buffer.alloc(12, 0x00).toString('base64url');
const CT = Buffer.alloc(40, 0x09).toString('base64url');

async function withApp(t, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'note-api-'));
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
  assert.equal((await post('get', { room: ROOM })).status, 204);
}));

test('put then get', (t) => withApp(t, async ({ post }) => {
  assert.deepEqual(await (await post('put', { room: ROOM, seq: 1, iv: IV, ct: CT })).json(),
    { seq: 1 });
  assert.deepEqual(await (await post('get', { room: ROOM })).json(),
    { seq: 1, iv: IV, ct: CT });
}));

test('a stale sequence is 409 and reports the current one', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, seq: 3, iv: IV, ct: CT });
  const response = await post('put', { room: ROOM, seq: 2, iv: IV, ct: CT });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).seq, 3);
}));

test('a sequence jump is refused', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('put', { room: ROOM, seq: 2 ** 40, iv: IV, ct: CT })).status, 409);
}));

test('clear empties the room and lets it restart', (t) => withApp(t, async ({ post }) => {
  await post('put', { room: ROOM, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('clear', { room: ROOM })).status, 200);
  assert.equal((await post('get', { room: ROOM })).status, 204);
  assert.equal((await post('put', { room: ROOM, seq: 1, iv: IV, ct: CT })).status, 200);
}));

test('malformed requests are rejected', (t) => withApp(t, async ({ post }) => {
  const shortRoom = Buffer.alloc(8, 0x01).toString('base64url');
  const cases = [
    ['get', { room: shortRoom }],
    ['get', { room: 5 }],
    ['get', {}],
    ['get', { room: `${ROOM.slice(0, -1)}!` }],
    ['get', '[1,2,3]'],
    ['get', 'not json'],
    ['put', { room: ROOM, seq: 0, iv: IV, ct: CT }],
    ['put', { room: ROOM, seq: 1.5, iv: IV, ct: CT }],
    ['put', { room: ROOM, seq: true, iv: IV, ct: CT }],
    ['put', { room: ROOM, seq: 1, iv: CT, ct: CT }],
    ['put', { room: ROOM, seq: 1, iv: IV, ct: 'AAAA' }],
  ];
  for (const [endpoint, body] of cases) {
    assert.equal((await post(endpoint, body)).status, 400, JSON.stringify(body));
  }
}));

test('an oversized body is 413', (t) => withApp(t, async ({ post }) => {
  const oversized = Buffer.alloc(70_000).toString('base64url');
  assert.equal((await post('put', { room: ROOM, seq: 1, iv: IV, ct: oversized })).status, 413);
}));

test('the per-room rate limit bites', (t) => withApp(t, async ({ app, post }) => {
  const seen = new Set();
  for (let i = 0; i < app.roomLimiter.capacity + 10; i++) {
    seen.add((await post('get', { room: ROOM })).status);
  }
  assert.ok(seen.has(429), [...seen].join(','));
}));

test('the CSP header matches the script actually served', (t) => withApp(t, async ({ base }) => {
  // Catches the CRLF trap, and every future "edited the JS and forgot".
  const response = await fetch(`${base}/`);
  const csp = response.headers.get('content-security-policy');
  const body = Buffer.from(await response.arrayBuffer());
  for (const [tag, directive] of [['script', 'script-src'], ['style', 'style-src']]) {
    const text = body.toString('binary');
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text);
    const digest = createHash('sha256').update(Buffer.from(match[1], 'binary')).digest('base64');
    assert.ok(csp.includes(`${directive} 'sha256-${digest}'`), directive);
  }
}));

test('the page has no inline handlers or style attributes', (t) => withApp(t, async ({ base }) => {
  // Both are blocked by a hash-based CSP, and both fail silently in the browser.
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/\son[a-z]+\s*=/.test(body), false);
  assert.equal(/\sstyle\s*=/.test(body), false);
  assert.equal(body.split('<script').length - 1, 1);
  assert.equal(body.split('<style').length - 1, 1);
}));

test('the page loads nothing from another origin', (t) => withApp(t, async ({ base }) => {
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/(src|href)\s*=\s*"(https?:)?\/\//.test(body), false);
}));

test('every element the script reaches for exists', (t) => withApp(t, async ({ base }) => {
  // A mistyped id throws at load time in the browser and nowhere else.
  const body = await (await fetch(`${base}/`)).text();
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(body)[1];
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

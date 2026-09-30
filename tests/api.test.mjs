// The HTTP surface of server/index.mjs, against a real listener on a random port: status
// codes, limits, rate limiting, and the rules the served page has to keep for its CSP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp, MAX_BODY, MAX_CT, MAX_SLOT } from '../server/index.mjs';

const ROOM = Buffer.alloc(16, 0x07).toString('base64url');
const IV = Buffer.alloc(12, 0x00).toString('base64url');
const CT = Buffer.alloc(40, 0x09).toString('base64url');
const TEXT = 0;
const FILE = 1;

async function withApp(run, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-api-'));
  const app = createApp({ dbPath: path.join(dir, 'api.db'), ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  const post = (endpoint, body, headers = {}) => fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  try {
    await run({ app, base, port, post });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
}

test('an empty room answers 204', () => withApp(async ({ post }) => {
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 204);
}));

test('put then get', () => withApp(async ({ post }) => {
  assert.deepEqual(await (await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT })).json(),
    { seq: 1 });
  assert.deepEqual(await (await post('get', { room: ROOM, slot: TEXT })).json(),
    { seq: 1, iv: IV, ct: CT });
}));

test('a stale sequence is 409 and reports the current one', () => withApp(async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 3, iv: IV, ct: CT });
  const response = await post('put', { room: ROOM, slot: TEXT, seq: 2, iv: IV, ct: CT });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).seq, 3);
}));

test('a sequence jump is refused', () => withApp(async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('put', { room: ROOM, slot: TEXT, seq: 2 ** 40, iv: IV, ct: CT })).status, 409);
}));

test('clear empties the room and lets it restart', () => withApp(async ({ post }) => {
  await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT });
  assert.equal((await post('clear', { room: ROOM, slot: TEXT })).status, 200);
  assert.equal((await post('get', { room: ROOM, slot: TEXT })).status, 204);
  assert.equal((await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: CT })).status, 200);
}));

test('malformed requests are rejected', () => withApp(async ({ post }) => {
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

test('a ciphertext over the limit is 413', () => withApp(async ({ post }) => {
  const oversized = Buffer.alloc(MAX_CT + 1).toString('base64url');
  assert.equal(
    (await post('put', { room: ROOM, slot: TEXT, seq: 1, iv: IV, ct: oversized })).status, 413);
}));

test('a body over the limit is 413 before it is read', () => withApp(async ({ base }) => {
  // Declared, not sent: readBody must refuse on Content-Length alone, or a large upload
  // is buffered in full before anyone checks whether it was allowed.
  const response = await fetch(`${base}/api/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY + 1) },
    body: 'x'.repeat(MAX_BODY + 1),
  });
  assert.equal(response.status, 413);
}));

test('a chunked body over the limit is 413, not a reset', () => withApp(async ({ port }) => {
  // No Content-Length, so the limit only trips mid-stream. The response has to go out
  // before the socket closes, or the client sees a dropped connection and no reason.
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/put' });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    // Once the server has answered and closed, further writes may fail; that is fine.
    request.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent <= MAX_BODY && !request.destroyed) {
        sent += chunk.length;
        if (!request.write(chunk)) return request.once('drain', pump);
      }
      request.end();
    };
    pump();
  });
  assert.equal(status, 413);
}));

test('a wrong method on a known path is 405 and says what is allowed', () =>
  withApp(async ({ base }) => {
    const get = await fetch(`${base}/api/put`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const post = await fetch(`${base}/app.js`, { method: 'POST', body: '' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    assert.equal((await fetch(`${base}/nope`, { method: 'POST', body: '' })).status, 404);
  }));

// The IP bucket key is visible on the limiter, which is what the proxy setting decides.
const FORWARDED = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };

test('without TRUST_PROXY, X-Forwarded-For is ignored', () => withApp(async ({ app, post }) => {
  await post('get', { room: ROOM, slot: TEXT }, FORWARDED);
  assert.equal(app.ipLimiter.buckets.has('203.0.113.9'), false);
  assert.equal(app.ipLimiter.buckets.size, 1);
}));

test('with TRUST_PROXY, the first X-Forwarded-For entry is the client', () =>
  withApp(async ({ app, post }) => {
    await post('get', { room: ROOM, slot: TEXT }, FORWARDED);
    assert.equal(app.ipLimiter.buckets.has('203.0.113.9'), true);
  }, { trustProxy: true }));

test('slots are stored apart and cleared apart', () => withApp(async ({ post }) => {
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

test('the per-room rate limit bites', () => withApp(async ({ app, post }) => {
  const seen = new Set();
  for (let i = 0; i < app.roomLimiter.capacity + 10; i++) {
    seen.add((await post('get', { room: ROOM, slot: TEXT })).status);
  }
  assert.ok(seen.has(429), [...seen].join(','));
}));

test('the CSP still pins the inline style to its bytes', () => withApp(async ({ base }) => {
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

test('modules are served, and only the ones that exist', () => withApp(async ({ base }) => {
  const response = await fetch(`${base}/app.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${base}/qr.js`)).status, 200);
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
}));

test('the page has no inline handlers or style attributes', () => withApp(async ({ base }) => {
  // Both are blocked by a hash-based CSP, and both fail silently in the browser.
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/\son[a-z]+\s*=/.test(body), false);
  assert.equal(/\sstyle\s*=/.test(body), false);
  // Exactly one <script>, and it has no body: the code arrives as same-origin modules.
  assert.equal(body.split('<script').length - 1, 1);
  assert.match(body, /<script type="module" src="\/app\.js"><\/script>/);
  assert.equal(body.split('<style').length - 1, 1);
}));

test('the page loads nothing from another origin', () => withApp(async ({ base }) => {
  const body = await (await fetch(`${base}/`)).text();
  assert.equal(/(src|href)\s*=\s*"(https?:)?\/\//.test(body), false);
}));

test('every element the script reaches for exists', () => withApp(async ({ base }) => {
  // A mistyped id throws at load time in the browser and nowhere else.
  const body = await (await fetch(`${base}/`)).text();
  const script = await (await fetch(`${base}/app.js`)).text();
  const wanted = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const present = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(wanted.size > 0);
  for (const id of wanted) assert.ok(present.has(id), `missing element #${id}`);

  const screens = new Set([...script.matchAll(/(?:show|goTo|setRoot)\('([^']+)'\)/g)].map((m) => m[1]));
  const declared = new Set([...body.matchAll(/data-screen="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(screens.size > 0);
  for (const name of screens) assert.ok(declared.has(name), `missing screen ${name}`);
}));

test('security headers', () => withApp(async ({ base }) => {
  const headers = (await fetch(`${base}/`)).headers;
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('cache-control'), 'no-store');
}));

test('icons and manifest are served, unknown paths are not', () => withApp(async ({ base }) => {
  assert.equal((await fetch(`${base}/icon-192.png`)).status, 200);
  assert.equal((await fetch(`${base}/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/../server/index.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
}));

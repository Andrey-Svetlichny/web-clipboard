// web-clipboard — a zero-knowledge relay for one encrypted record per room.
//
// The server is deliberately incurious: it stores an opaque blob under the hash of a key
// it never keeps, and hands it back to whoever proves they have that key. See spec.md.
//
// No dependencies, on purpose. node:sqlite and node:http are enough, and every package
// that is not here is one that cannot ship a surprise into a box holding your passwords.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RateLimiter } from './ratelimit.mjs';
import { SeqConflict, Store, roomHash } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');

// One file per record, so a request carries at most one attachment: the ceiling is a
// single file plus its base64url inflation, not the whole attachment set.
export const MAX_BODY = 3 * 1024 * 1024;
export const MAX_CT = 2 * 1024 * 1024;
export const MAX_SLOT = 5;
const ROOM_KEY_LEN = 16;
const IV_LEN = 12;
const SWEEP_EVERY_MS = 300_000;
// How long an oversized upload may keep arriving after its 413 has been sent.
const LINGER_MS = 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const badRequest = (why) => new HttpError(400, why);
const tooLarge = () => new HttpError(413, 'too large');

// ----------------------------------------------------------------------- assets

function cspHash(bytes) {
  return `'sha256-${createHash('sha256').update(bytes).digest('base64')}'`;
}

// Hash the exact bytes between <tag> and </tag>, which is what the browser hashes.
// Reading as text and re-encoding would rewrite CRLF and produce a hash that is correct
// on one machine and blank-pages the browser on another, so this stays in bytes.
function inlineHash(html, tag) {
  const opening = Buffer.from(`<${tag}`);
  const closing = Buffer.from(`</${tag}>`);
  const start = html.indexOf(opening);
  const bodyStart = start === -1 ? -1 : html.indexOf(Buffer.from('>'), start) + 1;
  const end = bodyStart === -1 ? -1 : html.indexOf(closing, bodyStart);
  if (start === -1 || end === -1) throw new Error(`no inline <${tag}> block in index.html`);
  return cspHash(html.subarray(bodyStart, end));
}

function loadAssets(webDir) {
  const index = readFileSync(path.join(webDir, 'index.html'));
  const icons = new Map();
  const scripts = new Map();
  // Strict patterns: the directory serves exactly what they match and nothing beside it.
  for (const name of readdirSync(webDir)) {
    if (/^icon-[\w.-]+\.png$/.test(name)) icons.set(name, readFileSync(path.join(webDir, name)));
    if (/^[\w.-]+\.js$/.test(name)) scripts.set(name, readFileSync(path.join(webDir, name)));
  }
  const csp = [
    "default-src 'none'",
    // Scripts are modules from this same origin. That is weaker than a hash only in
    // theory: nothing can be planted here, since the server serves only what is listed
    // above and attachments leave as JSON.
    "script-src 'self'",
    // The style stays inside the page, so it is still pinned by its hash.
    `style-src ${inlineHash(index, 'style')}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    index, manifest: readFileSync(path.join(webDir, 'manifest.json')), icons, scripts, csp,
  };
}

// --------------------------------------------------------------------- transport

function send(res, status, body, type, extra = {}) {
  const headers = {
    // No preload and no includeSubDomains: this runs on a subdomain of a domain used
    // for other things, and preload is close to irreversible.
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    'cache-control': 'no-store',
    ...extra,
  };
  if (type) headers['content-type'] = type;
  if (body === null) {
    res.writeHead(status, headers).end();
    return;
  }
  headers['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, headers).end(body);
}

const sendJson = (res, status, value, extra) =>
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);

// Listeners rather than for await: leaving a for-await loop early destroys the stream,
// and with it the socket the 413 still has to go out on.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.off('data', onData);
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Buffer.from(..., 'base64url') silently ignores characters it does not recognise, so
// the shape is checked before decoding and the length after. The encoded length is
// capped first, from the decoded size it may reach: n bytes are ceil(4n / 3) characters.
function decodeB64u(value, { exact, limit = MAX_CT } = {}) {
  if (typeof value !== 'string') throw badRequest('bad field');
  if (value.length > Math.ceil(((exact ?? limit) * 4) / 3)) {
    throw exact === undefined ? tooLarge() : badRequest('bad length');
  }
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw badRequest('bad base64');
  const raw = Buffer.from(value, 'base64url');
  if (exact !== undefined && raw.length !== exact) throw badRequest('bad length');
  return raw;
}

const encodeB64u = (raw) => Buffer.from(raw).toString('base64url');

// Slot 0 is the text and the manifest; 1..MAX_SLOT are files. The server attaches no
// meaning to either, it just refuses anything outside the range.
function validateSlot(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SLOT) throw badRequest('bad slot');
  return value;
}

// X-Forwarded-For is only worth reading behind a proxy that overwrites it, as
// deploy/nginx-web-clipboard.conf does. Exposed directly, the header says whatever the
// client wants, and honouring it would let anyone choose their own rate-limit bucket.
function clientIp(req, trustProxy) {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '?';
}

// ---------------------------------------------------------------------- the app

export function createApp({
  dbPath,
  ttlSeconds = 24 * 60 * 60,
  webDir = WEB_DIR,
  trustProxy = false,
} = {}) {
  const assets = loadAssets(webDir);
  const store = new Store(dbPath, ttlSeconds);
  const roomLimiter = new RateLimiter(120, 600);
  const ipLimiter = new RateLimiter(300, 600);
  let lastSweep = 0;

  function maybeSweep() {
    const at = Date.now();
    if (at - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = at;
    store.sweep();
  }

  // Every endpoint starts here, so the sweep runs on reads and writes alike.
  async function readRoom(req) {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw badRequest('bad json');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('bad json');
    }
    const roomKey = decodeB64u(payload.room, { exact: ROOM_KEY_LEN });
    if (!ipLimiter.allow(clientIp(req, trustProxy))) throw new HttpError(429, 'slow down');
    if (!roomLimiter.allow(roomHash(roomKey))) throw new HttpError(429, 'slow down');
    maybeSweep();
    return { payload, roomKey };
  }

  const routes = {
    'POST /api/get': async (req, res) => {
      const { payload, roomKey } = await readRoom(req);
      const slot = validateSlot(payload.slot);
      const record = store.get(roomKey, slot);
      if (!record) return send(res, 204, null);
      return sendJson(res, 200, {
        seq: record.seq,
        iv: encodeB64u(record.iv),
        ct: encodeB64u(record.ct),
      });
    },

    'POST /api/put': async (req, res) => {
      const { payload, roomKey } = await readRoom(req);
      const slot = validateSlot(payload.slot);
      const { seq } = payload;
      if (!Number.isSafeInteger(seq) || seq <= 0) throw badRequest('bad seq');
      const iv = decodeB64u(payload.iv, { exact: IV_LEN });
      const ct = decodeB64u(payload.ct, { limit: MAX_CT });
      // A 16-byte GCM tag plus at least one byte of plaintext.
      if (ct.length < 17) throw badRequest('bad ct');
      try {
        store.put(roomKey, slot, seq, iv, ct);
      } catch (error) {
        if (error instanceof SeqConflict) {
          return sendJson(res, 409, { error: 'seq', seq: error.current });
        }
        throw error;
      }
      return sendJson(res, 200, { seq });
    },

    'POST /api/clear': async (req, res) => {
      const { payload, roomKey } = await readRoom(req);
      // No slot means the whole room, which is how unlinking and "delete everything"
      // stay one request rather than one per attachment.
      const slot = payload.slot === undefined ? null : validateSlot(payload.slot);
      store.clear(roomKey, slot);
      return sendJson(res, 200, {});
    },

    'GET /': (req, res) =>
      send(res, 200, assets.index, 'text/html; charset=utf-8',
        { 'content-security-policy': assets.csp }),

    'GET /manifest.json': (req, res) =>
      send(res, 200, assets.manifest, 'application/manifest+json'),

    'GET /healthz': (req, res) => send(res, 200, 'ok', 'text/plain; charset=utf-8'),
  };

  // Icons and modules are served from what was read at boot, so they are routes too.
  for (const [name, bytes] of assets.icons) {
    routes[`GET /${name}`] = (req, res) => send(res, 200, bytes, 'image/png');
  }
  for (const [name, bytes] of assets.scripts) {
    routes[`GET /${name}`] = (req, res) =>
      send(res, 200, bytes, 'text/javascript; charset=utf-8');
  }

  // Path -> the methods it answers, for the Allow header on a 405.
  const allowed = new Map();
  for (const key of Object.keys(routes)) {
    const [method, pathname] = key.split(' ');
    allowed.set(pathname, [...(allowed.get(pathname) ?? []), method]);
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, null);
    }

    try {
      // HEAD is GET without the body, which node:http already drops.
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const route = routes[`${method} ${pathname}`];
      if (route) return await route(req, res);
      if (allowed.has(pathname)) {
        return sendJson(res, 405, { error: 'method not allowed' },
          { allow: allowed.get(pathname).join(', ') });
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (!(error instanceof HttpError)) {
        console.error('unhandled', error);
        return sendJson(res, 500, { error: 'server error' });
      }
      if (req.complete) return sendJson(res, error.status, { error: error.message });
      // The body is still arriving (an oversized upload). Answer first, then drain it for
      // a moment: closing on unread data resets the connection, and the client may never
      // see the response that explains why. An upload that outlasts that is cut off.
      res.once('finish', () => {
        const cutOff = setTimeout(() => req.socket.destroy(), LINGER_MS).unref();
        req.once('end', () => clearTimeout(cutOff));
        req.resume();
      });
      return sendJson(res, error.status, { error: error.message });
    }
  });

  server.on('close', () => store.close());
  return { server, roomLimiter, ipLimiter };
}

// ------------------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const { server } = createApp({
    dbPath: process.env.CLIPBOARD_DB ?? '/data/web-clipboard.db',
    ttlSeconds: Number(process.env.CLIPBOARD_TTL_SECONDS ?? 24 * 60 * 60),
    trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
  });

  server.listen(port, host, () => console.log(`web-clipboard listening on ${host}:${port}`));

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

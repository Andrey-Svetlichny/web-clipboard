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
import { SeqConflict, Store } from './store.mjs';

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
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

export function loadAssets(webDir = WEB_DIR) {
  const index = readFileSync(path.join(webDir, 'index.html'));
  const icons = new Map();
  for (const name of readdirSync(webDir)) {
    if (/^icon-[\w.-]+\.png$/.test(name)) icons.set(name, readFileSync(path.join(webDir, name)));
  }
  const csp = [
    "default-src 'none'",
    `script-src ${inlineHash(index, 'script')}`,
    `style-src ${inlineHash(index, 'style')}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { index, manifest: readFileSync(path.join(webDir, 'manifest.json')), icons, csp };
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

const sendJson = (res, status, value) =>
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Buffer.from(..., 'base64url') silently ignores characters it does not recognise, so
// the shape is checked before decoding and the length after.
function decodeB64u(value, { exact, limit } = {}) {
  const ceiling = limit ?? MAX_CT;
  if (typeof value !== 'string' || value.length > ceiling * 2) throw badRequest('bad field');
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw badRequest('bad base64');
  const raw = Buffer.from(value, 'base64url');
  if (exact !== undefined && raw.length !== exact) throw badRequest('bad length');
  if (limit !== undefined && raw.length > limit) throw tooLarge();
  return raw;
}

const encodeB64u = (raw) => Buffer.from(raw).toString('base64url');

// Slot 0 is the text and the manifest; 1..MAX_SLOT are files. The server attaches no
// meaning to either, it just refuses anything outside the range.
function decodeSlot(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SLOT) throw badRequest('bad slot');
  return value;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '?';
}

// ---------------------------------------------------------------------- the app

export function createApp({
  dbPath,
  ttlSeconds = 24 * 60 * 60,
  webDir = WEB_DIR,
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
    if (!ipLimiter.allow(clientIp(req))) throw new HttpError(429, 'slow down');
    if (!roomLimiter.allow(createHash('sha256').update(roomKey).digest('hex'))) {
      throw new HttpError(429, 'slow down');
    }
    return { payload, roomKey };
  }

  const routes = {
    'POST /api/get': async (req, res) => {
      const { payload, roomKey } = await readRoom(req);
      const slot = decodeSlot(payload.slot);
      maybeSweep();
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
      const slot = decodeSlot(payload.slot);
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
      const slot = payload.slot === undefined ? null : decodeSlot(payload.slot);
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

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, null);
    }

    try {
      const route = routes[`${req.method} ${pathname}`];
      if (route) return await route(req, res);

      if (req.method === 'GET' && assets.icons.has(pathname.slice(1))) {
        return send(res, 200, assets.icons.get(pathname.slice(1)), 'image/png');
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: error.message });
      }
      console.error('unhandled', error);
      return sendJson(res, 500, { error: 'server error' });
    }
  });

  server.on('close', () => store.close());
  return { server, store, assets, roomLimiter, ipLimiter };
}

// ------------------------------------------------------------------------- main

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const { server } = createApp({
    dbPath: process.env.CLIPBOARD_DB ?? '/data/web-clipboard.db',
    ttlSeconds: Number(process.env.CLIPBOARD_TTL_SECONDS ?? 24 * 60 * 60),
  });

  server.listen(port, host, () => console.log(`web-clipboard listening on ${host}:${port}`));

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

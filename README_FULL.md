# note — full documentation

For the short version and install instructions, see [README.md](README.md). For the
protocol itself, see [spec.md](spec.md).

## What it protects against, and what it does not

This matters more than the feature list, so it goes first.

**It protects against the network, including a TLS-intercepting proxy.** Managed machines
routinely carry a corporate root CA, so HTTPS alone would show your passwords to whoever
runs the proxy. Everything here is encrypted in the browser with a key derived from a code
the server never sees. A proxy sees a request to a web page and an opaque blob.

**It protects against the server and its backups.** The server stores a blob under the
*hash* of a room key it never holds, so a copy of the database — leaked, stolen, or
subpoenaed — decrypts to nothing.

It does **not** protect against:

1. **A compromised server.** The same server also ships the JavaScript, so whoever
   controls it can serve a version that steals the key on the next load. That is inherent
   to end-to-end encryption delivered through a web page, and it is the price of working
   on a phone with nothing installed. Run it on a machine you control.
2. **Whoever can read the browser profile on a paired device.** The stored key can read
   everything sent *afterwards*, not just what happens to be in the room now. Imaging a VM,
   EDR with disk access, and offboarding capture all reach it. On a machine you do not own,
   pair with "stay signed in" switched **off**, and press **Unlink this device** when you
   are done.
3. **Anything watching the endpoint itself.** The value lands in that machine's clipboard
   and then in an application. Windows clipboard history (Win+V) keeps it, and endpoint DLP
   agents can read it. This moves secrets past the *proxy*, not past an *agent on the
   machine*. Nothing built this way could.

Ordinary consequence of all three: use it to get your own credentials *into* a machine you
are authorised to use. That is what it is for.

## Using it

**On your own PC (first).** Open the site, *Create a new code*, and save the code — or the
link, which carries it — in your password manager. It is shown once and never stored;
losing it means starting over.

**On the work VM.** Open the site, choose *I have a code*, and type the twenty characters.
**Do not open the link there.** The link carries the code in its fragment, and although a
fragment is never sent to a server, the full URL lands in browser history, session
restore, and managed-browser reporting. Typing is the quiet path, and it is the only place
you have to type anything.

Hyphens, spacing and case do not matter, and `O`/`I`/`L` are folded to `0`/`1`/`1`, so the
code survives being read off one screen and typed into another.

**On your phone, if you want it.** Open the same link there — it is a machine you own, so
the link is fine. Useful when the password you need is in a phone password manager rather
than on the PC.

**Then.** Paste into the Send box and press Send. On the VM the tab fetches when you
switch to it — no polling, so nothing beacons at a proxy while you are not looking. Values
arrive masked; *Show* reveals one, *Copy* takes it.

It works in reverse too — the VM can send, your PC can receive — which is occasionally
useful for pulling an error message out. Same rules apply.

One line per value. `Label: value` names a line, which is what makes a block like this
work in a single trip:

```
IBAN: DE89 3704 0044 0532 0130 00
BIC: COBADEFFXXX
Password: correct-horse-battery-staple
```

Tick *Send as a single value* when the line breaks are part of the secret.

Once every value has been copied, the record is deleted from the server automatically.

**If you do use a phone, add it to the home screen.** Beyond convenience, iOS evicts
stored data for sites not visited in a week unless they have been added to the Home
Screen — without it you will be retyping the code there.

## Housekeeping

- **New code** rotates the pairing secret: the old room is deleted and every other device
  has to be re-paired. Do this when you hand back a machine you had paired.
- **Unlink this device** deletes the key from this browser and clears the room.
- A re-imaged VM is just a new device: type the code again.

## Deployment

The install steps are in [README.md](README.md). What they leave out:

**The domain matters more than it sounds.** An existing, aged domain is worth having here:
corporate proxies block or flag domains they have no category for, and a brand-new one is
exactly that. A subdomain of something you have owned for a while inherits its reputation.

**State is two Docker volumes.** `note-data` holds the SQLite file, `caddy-data` the
certificates. Backing up `note-data` is optional — everything in it expires within a day.

**`NOTE_TTL_SECONDS`** (default `86400`) sets how long a record survives. Lowering it to
`3600` costs nothing in practice, since a send is usually collected within a minute, and
it shrinks the window in which a captured device profile finds anything.

**One process, on purpose.** SQLite writes serialise and nothing here needs more; the
rate limiters are in-memory, so a second replica would also mean a second set of buckets.

## Developing

Node 22.5 or newer — the server uses the built-in `node:sqlite`. There are **no
dependencies**, so there is nothing to install:

```sh
npm run dev     # http://localhost:8080, restarts on every edit under web/ and server/
npm test        # 36 tests, no server needed
npm run smoke   # end-to-end against the dev server; pass a URL for anywhere else
```

`npm run dev` points the database at `./dev.db` (git-ignored, along with its two WAL
siblings) and binds to loopback. It leaves `PORT` at its 8080 default so `npm run smoke`
needs no argument. Without it you would have to set `CLIPBOARD_DB` by hand: the default is
`/data/web-clipboard.db`, which exists in the container and nowhere else, and SQLite
reports its absence as a bare "disk I/O error".

`localhost` counts as a secure context, so WebCrypto works locally without TLS. Nothing
else does. Opening the dev server from a phone at `http://192.168.x.x:8080` shows "this
browser will not let the page encrypt anything" instead of the pairing screen — the page
refusing to pretend, not a bug. Testing across devices needs real HTTPS: the Caddy stack
with a domain, or a tunnel.

**The page is read once, at startup.** `createApp()` calls `loadAssets()` and serves those
same buffers for the life of the process, because the CSP hash for the inline style is
computed from those exact bytes. `npm run dev` covers this with `--watch-path=web`.
Anywhere else, editing anything under `web/` changes nothing until the process restarts —
`systemctl restart web-clipboard`, or `docker compose up -d --build` under Docker, where
`web/` is baked into the image and a plain restart re-runs the same layers.

`--watch-path` is macOS and Windows only. On Linux, drop those two flags from the `dev`
script: plain `--watch` still catches server edits, and changes under `web/` need a manual
restart.
Either way a restart takes a few seconds, because the SIGTERM handler calls
`server.close()`, which waits for open keep-alive connections to drain.

`tests/smoke.mjs` drives the real client crypto — it imports the very modules the browser
loads — through a live server, so it exercises the same code the browser runs.

**After editing `web/crypto.js` or `web/code.js`, regenerate the vectors:**

```sh
npm run vectors
```

The `vectors.json is not stale` test fails if you forget. Read the diff afterwards:
`codes` and `normalize` should be byte-identical unless the key schedule really changed,
so movement there means something cryptographic shifted that perhaps should not have. The vectors pin the browser
against `tests/reference.mjs`, which implements `spec.md` independently: HKDF expanded by
hand from RFC 5869 rather than called through WebCrypto, and AES-GCM through
`node:crypto` rather than `crypto.subtle`. A key-schedule mismatch is otherwise silent at
runtime and horrible to debug.

Two rules the page has to keep, both enforced by tests, both failing silently in a browser
if broken: no `onclick=` handlers and no `style=` attributes anywhere, and nothing loaded
from another origin. The inline `<style>` stays pinned to its bytes by a hash, so a stray
inline style is blocked rather than merely discouraged.

## Layout

```
spec.md              the protocol — read this before changing anything cryptographic
server/index.mjs     three endpoints, static serving, CSP, security headers
server/store.mjs     rooms and their numbered records in SQLite, sequence rules, TTL
server/ratelimit.mjs token buckets per room and per IP
web/index.html       markup and style only
web/app.js           state, rendering, handlers — the only module that touches the DOM
web/api.js           put/get/clear, sealing and opening records; knows nothing of the DOM
web/crypto.js        base64url, HKDF, AES-GCM — mirrored by tests/reference.mjs
web/code.js          pairing code: alphabet, check character, normalising what was typed
web/store.js         device keys in IndexedDB
web/qr.js            QR encoder, byte mode, level M, versions 1-6
web/agent.js         «Chrome on Windows» from navigator
tests/reference.mjs  spec.md reimplemented against node:crypto, for cross-checking
tests/make_vectors.mjs, tests/smoke.mjs
```

ES modules, served as-is: no bundler, no build step, and still no dependency reaches the
page that holds the keys. Because scripts are now separate files, `script-src` is `'self'`
rather than a hash; the inline `<style>` is still pinned to its bytes. Nothing else can be
placed on this origin — the server serves `index.html`, the manifest, and files matching
`^icon-[\w.-]+\.png$` or `^[\w.-]+\.js$` read from `web/` at boot, and attachments never
come back as files, only as JSON inside `/api/get`.

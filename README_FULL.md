# web-clipboard — full documentation

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
   pair with "Stay signed in" switched **off**, and choose **Unlink this device** when you
   are done.
3. **Anything watching the endpoint itself.** The value lands in that machine's clipboard
   and then in an application. Windows clipboard history (Win+V) keeps it, and endpoint DLP
   agents can read it. This moves secrets past the *proxy*, not past an *agent on the
   machine*. Nothing built this way could.

Ordinary consequence of all three: use it to get your own credentials *into* a machine you
are authorised to use. That is what it is for.

## Using it

### Pairing

**On your own PC (first).** Open the site and choose **Create a new code**. The next
screen shows the code as a QR code and as text, with **Copy code** and **Copy link**. Save
the code — or the link, which carries it — in your password manager. It is shown once and
never stored; losing it means starting over.

**On the work VM.** Open the site, choose **I have a code**, and type the twenty
characters. **Do not open the link there.** The link carries the code in its fragment, and
although a fragment is never sent to a server, the full URL lands in browser history,
session restore, and managed-browser reporting. Typing is the quiet path, and it is the
only place you have to type anything.

Hyphens, spacing and case do not matter, and `O`/`I`/`L` are folded to `0`/`1`/`1`, so the
code survives being read off one screen and typed into another.

**On your phone, if you want it.** Scan the QR code, or open the link — it is a machine you
own, so the link is fine. Useful when the password you need is in a phone password manager
rather than on the PC.

### The main screen

One text box, with a toolbar above it:

- **Local / Diff / Shared** switches what the box shows. *Local* is your version, the one
  **Save** sends. *Shared* is the version that came in from the server; editing it makes
  it yours, and the switcher moves back to Local. *Diff* shows what the incoming version
  changes in yours. When a newer version arrives while you have text of your own, the box
  opens in Diff so the change cannot go unnoticed; nothing incoming ever overwrites what
  you typed.
- **Attach** uploads a file straight away, independently of the text. Attached files are
  listed under the box: click a name to download it, × to remove it.
- **Pull** fetches the latest version now.
- **Save** sends your version. It is greyed out when there is nothing new to send. Saving
  an empty box with no attachments deletes the room from the server.
- **⋮** opens a menu with **Settings**, **New code** and **Unlink this device**.

Under the toolbar a status line shows who wrote the current version and when ("who –
when"), and any error. The age comes from the timestamp inside the ciphertext, which the
server cannot forge.

The tab fetches when you switch to it. Beyond that it only polls if you ask it to (see
Settings), so by default nothing beacons at a proxy while you are not looking.

It works in both directions — the VM can save, your PC can pull — which is occasionally
useful for getting an error message out. Same rules apply.

### Settings

- **Browser tab name** — local only, and per tab: a label for this browser tab, so two
  open tabs can be told apart. It never leaves the browser.
- **Device name** — shown remotely, encrypted: it travels inside the ciphertext as the
  "who" in the status line on the other devices.
- **Check for new text automatically** — polls every few seconds while the tab is in
  front. Only available on a device that stays signed in.

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

**State is one Docker volume.** `clipboard-data` holds the SQLite file. Backing it up is
optional — everything in it expires within a day. TLS certificates belong to the host's
nginx and certbot, not to the container.

**`CLIPBOARD_TTL_SECONDS`** (default `86400`) sets how long a record survives. Lowering it
to `3600` costs nothing in practice, since a saved text is usually collected within a
minute, and it shrinks the window in which a captured device profile finds anything.

**`TRUST_PROXY`** (default off) makes the per-IP rate limit read `X-Forwarded-For`. Set it
only behind a proxy that overwrites that header, as the committed nginx config does; both
`docker-compose.yml` and `deploy/web-clipboard.service` set it for that reason.

**One process, on purpose.** SQLite writes serialise and nothing here needs more; the
rate limiters are in-memory, so a second replica would also mean a second set of buckets.

## Developing

Node 22.13 or newer — the server uses the built-in `node:sqlite`, which needs no flag from
that release on. There are no dependencies, so there is nothing to install:

```sh
npm run dev     # http://localhost:8080, restarts on every edit under web/ and server/
npm test        # no server needed
npm run smoke   # end-to-end against the dev server; pass a URL for anywhere else
```

`npm run dev` loads `dev.env`, which points the database at `./dev.db` (git-ignored, along
with its two WAL siblings) and binds to loopback. It leaves `PORT` at its 8080 default so
`npm run smoke` needs no argument; if 8080 is taken, run with `PORT` set and pass the URL
to smoke. Without `dev.env` you would have to set `CLIPBOARD_DB` by hand: the default is
`/data/web-clipboard.db`, which exists in the container and nowhere else, and SQLite
reports its absence as a bare "disk I/O error".

`localhost` counts as a secure context, so WebCrypto works locally without TLS. Nothing
else does. Opening the dev server from a phone at `http://192.168.x.x:8080` shows "this
browser will not let the page encrypt anything" instead of the pairing screen — the page
refusing to pretend, not a bug. Testing across devices needs real HTTPS: a deployment
behind nginx with a domain, or a tunnel.

**The page is read once, at startup.** `createApp()` reads `web/` and serves those same
buffers for the life of the process, because the CSP hash for the inline style is computed
from those exact bytes. `npm run dev` covers this with `--watch-path=web`. Anywhere else,
editing anything under `web/` changes nothing until the process restarts —
`systemctl restart web-clipboard`, or `docker compose up -d --build` under Docker, where
`web/` is baked into the image and a plain restart re-runs the same layers.

Older Node releases support `--watch-path` only on macOS and Windows. If yours refuses it
on Linux, replace both flags in the `dev` script with plain `--watch`: it still follows the
server's imports, and changes under `web/` then need a manual restart.
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
so movement there means something cryptographic shifted that perhaps should not have. The
vectors pin the browser against `tests/reference.mjs`, which implements `spec.md`
independently: HKDF expanded by hand from RFC 5869 rather than called through WebCrypto,
and AES-GCM through `node:crypto` rather than `crypto.subtle`. A key-schedule mismatch is
otherwise silent at runtime and horrible to debug.

Two rules the page has to keep, both enforced by tests, both failing silently in a browser
if broken: no inline `<script>`, `onclick=` handlers or `style=` attributes anywhere, and
nothing loaded from another origin. The inline `<style>` stays pinned to its bytes by a
hash, so a stray inline style is blocked rather than merely discouraged.

## Layout

```
spec.md                  the protocol — read this before changing anything cryptographic
server/index.mjs         three endpoints, static serving, CSP, security headers
server/store.mjs         rooms and their numbered records in SQLite, sequence rules, TTL
server/ratelimit.mjs     token buckets per room and per IP
web/index.html           markup and style only
web/app.js               state, rendering, handlers — the only module that touches the DOM
web/api.js               put/get/clear, sealing and opening records; knows nothing of the DOM
web/crypto.js            base64url, HKDF, AES-GCM — mirrored by tests/reference.mjs
web/code.js              pairing code: alphabet, check character, normalising what was typed
web/diff.js              line diff behind the Diff view
web/store.js             device keys in IndexedDB
web/qr.js                QR encoder, byte mode, level M, versions 1-6
web/agent.js             "Chrome/Windows" from navigator
tests/*.test.mjs         the npm test suite
tests/reference.mjs      spec.md reimplemented against node:crypto, for cross-checking
tests/qr-reader.mjs      a minimal QR decoder, so the encoder is checked end to end
tests/make-vectors.mjs   regenerates tests/vectors.json
tests/smoke.mjs          end-to-end run against a live server
dev.env                  environment for npm run dev
.env.example             overrides for docker compose; copy to .env
deploy/                  nginx site and systemd unit
```

ES modules, served as-is: no bundler, no build step, and still no dependency reaches the
page that holds the keys. Because scripts are separate files, `script-src` is `'self'`
rather than a hash; the inline `<style>` is still pinned to its bytes. Nothing else can be
placed on this origin — the server serves `index.html`, the manifest, and files matching
`^icon-[\w.-]+\.png$` or `^[\w.-]+\.js$` read from `web/` at boot, and attachments never
come back as files, only as JSON inside `/api/get`.

# web-clipboard — protocol spec v1

Everything in this file is normative. The browser (JS) and the tests each implement it
independently: `web/crypto.js`/`web/code.js` on one side, `tests/reference.mjs` on the
other (HKDF expanded by hand from RFC 5869, AES-GCM through `node:crypto` rather than
`crypto.subtle`). `tests/vectors.json` pins them together. A mismatch here fails
silently at runtime and is miserable to debug, so change this file first.

## 1. Pairing code

Alphabet (Crockford base32, 32 chars, no `I` `L` `O` `U`):

```
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

A code is **20 characters**: 19 random characters (19 x 5 = **95 bits** of entropy)
followed by 1 checksum character.

```
checksum_char = ALPHABET[ SHA-256( UTF8(first_19_chars) )[0] & 0x1F ]
```

The checksum is computed over the **canonical uppercase 19-character string**, not over
packed bits and not over the typed string. No bit packing appears anywhere in this
protocol; that is deliberate.

Displayed in four groups of five for legibility: `XXXXX-XXXXX-XXXXX-XXXXX`.

### Normalisation (decoding user input)

1. Uppercase.
2. Drop every character that is not `[0-9A-Z]` (removes hyphens, spaces, newlines).
3. Map `O` -> `0`, `I` -> `1`, `L` -> `1`.
4. Reject if any remaining character is outside the alphabet (this rejects `U`).
5. Reject unless exactly 20 characters remain.
6. Reject if the checksum character does not match.

A 5-bit checksum admits roughly 1 typo in 32. That is why the UI distinguishes
"code looks wrong" from "paired but empty" from "could not decrypt" — see README_FULL.md.

## 2. Key schedule

The canonical 20-character code, UTF-8 encoded, is the HKDF input keying material.
There is no password stretching: 95 uniformly random bits have no dictionary attack,
so an iteration count would buy nothing and cost half a second on the phone.

```
IKM      = UTF8(code20)                              # 20 bytes, uppercase, no hyphens
salt     = UTF8("web-clipboard/v1")
roomKey  = HKDF-SHA256(IKM, salt, info=UTF8("web-clipboard/v1 r"), 16 bytes)
encKey   = HKDF-SHA256(IKM, salt, info=UTF8("web-clipboard/v1 k"), 32 bytes) -> AES-256-GCM
roomHash = SHA-256(roomKey)                          # 32 bytes, hex; server's primary key
```

`encKey` is imported non-extractable. `roomKey` is both the room identifier and the
capability to read and write it; there is no separate bearer token, because a second
credential sent on every request alongside the first is not a second factor.

The server stores only `roomHash`, never `roomKey`. A database leak therefore yields no
ability to read or overwrite any room.

## 3. Records and slots

A room holds up to `MAX_SLOT + 1` records — currently 6:

- **slot 0** — the shared text plus the manifest of attachments.
- **slots 1..MAX_SLOT** (currently 5) — one file each, raw bytes as the plaintext.

The server attaches no meaning to a slot beyond its number; it just refuses anything
outside `0..MAX_SLOT`. Splitting one file per slot means adding or removing an
attachment costs one record, not the whole set.

```
room:   { room_hash, expires_at }
record: { room_hash, slot, seq, iv, ct }
```

- `seq` — integer, strictly increasing **per slot**, starting at 1.
- `iv` — 12 random bytes, fresh per encryption.
- `ct` — AES-256-GCM ciphertext (includes the 16-byte tag), at least 17 bytes.
- `expires_at` — unix seconds, stored once on the room, not per record. Any write to
  any slot extends it, so an attachment never outlives the text that names it.

### AAD

```
AAD = roomKey (16 bytes) || slot (4 bytes, big-endian, unsigned) || seq (8 bytes, big-endian, unsigned)
```

Binding the sequence number into the AAD means a record cannot be replayed at a
different position without the tag failing. Binding the slot means a record from one
slot cannot be lifted into another slot of the same room at the same seq and still open.

### Plaintext, slot 0

UTF-8 JSON, serialised with no insignificant whitespace:

```json
{"v":1,"ts":1757808000,"items":[{"label":"","text":".."}],"files":[{"slot":1,"name":"passport.pdf","type":"application/pdf","size":123456}],"from":"My laptop · Chrome on Windows"}
```

- `ts` — unix **seconds** at encryption time, authenticated by the AEAD.
- `items` — an array of `{label, text}`. The current client always writes exactly one
  entry covering the whole box, with `label` always empty; the shape stays an array so a
  future multi-item client can add more without changing the record format.
- `files` — the attachment manifest: one `{slot, name, type, size}` entry per occupied
  file slot, `slot` in `1..MAX_SLOT`, `name` non-empty, `size` the plaintext byte count.
  `name` and `type` travel only inside this ciphertext; the server never sees them.
- `from` — optional device label, e.g. `"My laptop · Chrome on Windows"`, at most 64
  characters.

`ts` is the only replay defence a user can reason about, so the UI always renders the
record's age from it.

### Plaintext, slots 1..MAX_SLOT

Raw file bytes. Not JSON, not parsed — the ciphertext for a file slot is exactly the
attachment's content.

## 4. Transport

All endpoints are `POST /api/*` with a JSON body. `roomKey` travels **in the body** as
`room` (base64url), never in a path, query string, or header: proxies retain URL logs
near-universally and header logs often, request bodies much less often.

Binary fields are base64url, unpadded.

| Endpoint | Request | Response |
|---|---|---|
| `/api/get` | `{room, slot}` | `200 {seq, iv, ct}` or `204` |
| `/api/put` | `{room, slot, seq, iv, ct}` | `200 {seq}` |
| `/api/clear` | `{room}` or `{room, slot}` | `200 {}` |

`slot` is an integer `0..MAX_SLOT`. `/api/clear` without a `slot` deletes the whole room
(every slot); with a `slot` it deletes only that one record.

Errors: `400` malformed, `409 {seq}` sequence conflict (body carries the server's
current seq for that slot so the client can resynchronise), `413` too large, `429` rate
limited.

### Sequence rules (server-enforced, per slot)

- No record in that slot: accept `1 <= seq <= 1000`.
- Existing record in that slot at `s`: accept `s < seq <= s + 1000`.
- `/api/clear` with no `slot` deletes the room, so the next `put` to any slot in it
  starts from 1 again. `/api/clear` with a `slot` deletes only that record, so the next
  `put` to that slot starts from 1 while the other slots keep their own sequence.

The upper bound matters. Without it, anyone who ever saw the room key — including the
intercepting proxy — writes `seq = 2^53` and permanently bricks that slot, and the room
cannot be reallocated because `roomKey` is deterministic in the code.

### Sequence rules (client-enforced, per slot)

- Reject a fetched record whose `seq` is **strictly less** than the highest seq this
  device has seen for that slot: that is a rollback.
- Equal is accepted — it is the same record being re-read after a reload.
- On `204`, reset the floor for that slot to 0. The slot is empty because it was cleared
  or expired, and the next write legitimately starts from 1 again; a device that did not
  do the clearing would otherwise reject every future record from its peer.

That last rule is a deliberate trade. A server willing to answer `204` can lower a
client's floor and then replay an old record. What it cannot do is forge the `ts`
inside the AEAD, which is why the UI renders the record's age from it. Sequence numbers
keep two honest devices consistent; the timestamp is what a person can actually check.

## 5. Limits

- Request body: 3 MiB hard cap (`MAX_BODY`), checked before parsing. One record per
  request, so this bounds a single file plus its base64url inflation, not the whole
  attachment set.
- Ciphertext per slot: 2 MiB (`MAX_CT`), and at least 17 bytes (a 16-byte GCM tag plus
  one byte of plaintext).
- Attachment plaintext: the client itself enforces at most 5 files (`MAX_FILES`) of at
  most 1 MiB each (`MAX_FILE_BYTES`) — the server just carries whatever fits under
  `MAX_CT`.
- Rate limit: 120 requests per 10 min per room, 300 per 10 min per IP.

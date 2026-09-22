import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { SEQ_JUMP_LIMIT, SeqConflict, Store } from '../server/store.mjs';

const ROOM = Buffer.alloc(16, 0x01);
const OTHER = Buffer.alloc(16, 0x02);
const IV = Buffer.alloc(12, 0x00);
const TEXT = 0;
const FILE = 1;
const CT = Buffer.alloc(32, 0x03);

function freshStore(ttlSeconds = 3600) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-store-'));
  const file = path.join(dir, 'test.db');
  return { store: new Store(file, ttlSeconds), file };
}

test('round trip', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  const record = store.get(ROOM, TEXT);
  assert.equal(record.seq, 1);
  assert.deepEqual(record.iv, IV);
  assert.deepEqual(record.ct, CT);
  assert.equal(store.get(OTHER, TEXT), null);
});

test('put replaces rather than accumulating', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  store.put(ROOM, TEXT, 2, IV, Buffer.from('newer'));
  assert.equal(store.get(ROOM, TEXT).ct.toString(), 'newer');
});

test('the sequence must advance', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 5, IV, CT);
  for (const stale of [1, 5]) {
    assert.throws(() => store.put(ROOM, TEXT, stale, IV, CT), (error) => {
      assert.ok(error instanceof SeqConflict);
      assert.equal(error.current, 5);
      return true;
    });
  }
  store.put(ROOM, TEXT, 6, IV, CT);
});

test('the sequence cannot be jumped to the ceiling', (t) => {
  // Without this an intercepting proxy bricks the room permanently: the room id is
  // derived from the pairing code, so it can never be reallocated.
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  assert.throws(() => store.put(ROOM, TEXT, 2 ** 52, IV, CT), SeqConflict);
  store.put(ROOM, TEXT, 1 + SEQ_JUMP_LIMIT, IV, CT);
  assert.equal(store.get(ROOM, TEXT).seq, 1 + SEQ_JUMP_LIMIT);
});

test('the first write is bounded too', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  assert.throws(() => store.put(ROOM, TEXT, SEQ_JUMP_LIMIT + 1, IV, CT), SeqConflict);
  store.put(ROOM, TEXT, SEQ_JUMP_LIMIT, IV, CT);
});

test('clear lets the sequence restart', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 9, IV, CT);
  assert.equal(store.clear(ROOM), true);
  assert.equal(store.get(ROOM, TEXT), null);
  store.put(ROOM, TEXT, 1, IV, CT);
  assert.equal(store.get(ROOM, TEXT).seq, 1);
});

test('expired records are invisible, then swept', (t) => {
  const { store } = freshStore(60);
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT, 1000);
  assert.notEqual(store.get(ROOM, TEXT, 1030), null);
  assert.equal(store.get(ROOM, TEXT, 1061), null);
  // An expired room reads as empty, so its sequence starts over too.
  store.put(ROOM, TEXT, 1, IV, CT, 1061);
  assert.equal(store.sweep(1_000_000), 1);
});

test('the raw room key is never persisted', (t) => {
  const { store, file } = freshStore();
  store.put(ROOM, TEXT, 1, IV, CT);
  store.close();
  const blob = readFileSync(file);
  assert.equal(blob.includes(ROOM), false);
  assert.ok(blob.includes(Buffer.from(createHash('sha256').update(ROOM).digest('hex'))));
});

test('slots in a room are independent', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  store.put(ROOM, FILE, 1, IV, Buffer.from('bytes'));
  assert.equal(store.get(ROOM, TEXT).ct.toString(), CT.toString());
  assert.equal(store.get(ROOM, FILE).ct.toString(), 'bytes');
  // Sequence floors are per slot: a busy text slot must not lock out a fresh file slot.
  store.put(ROOM, TEXT, 2, IV, CT);
  store.put(ROOM, FILE, 2, IV, Buffer.from('newer'));
  assert.equal(store.get(ROOM, FILE).seq, 2);
});

test('clearing one slot leaves the rest of the room alone', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  store.put(ROOM, FILE, 1, IV, CT);
  assert.equal(store.clear(ROOM, FILE), true);
  assert.equal(store.get(ROOM, FILE), null);
  assert.notEqual(store.get(ROOM, TEXT), null);
});

test('clearing the room cascades to every slot', (t) => {
  // The cascade is silently a no-op if PRAGMA foreign_keys is ever dropped, which would
  // leave file records orphaned in a room nobody can reach.
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  store.put(ROOM, FILE, 1, IV, CT);
  assert.equal(store.clear(ROOM), true);
  assert.equal(store.get(ROOM, FILE), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n, 0);
});

test('any write extends the whole room, so files never outlive their text', (t) => {
  const { store } = freshStore(60);
  t.after(() => store.close());
  store.put(ROOM, FILE, 1, IV, CT, 1000);
  // The file would have expired at 1060 on its own; writing the text at 1050 carries it.
  store.put(ROOM, TEXT, 1, IV, CT, 1050);
  assert.notEqual(store.get(ROOM, FILE, 1100), null);
  assert.equal(store.get(ROOM, FILE, 1111), null);
});

test('a database from the one-record schema is discarded, not half-used', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-legacy-'));
  const file = path.join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE records (room_hash TEXT PRIMARY KEY, seq INTEGER NOT NULL, '
    + 'iv BLOB NOT NULL, ct BLOB NOT NULL, expires_at INTEGER NOT NULL)');
  legacy.exec("INSERT INTO records VALUES ('cafe', 1, x'00', x'00', 9999999999)");
  legacy.close();

  const store = new Store(file, 3600);
  t.after(() => store.close());
  store.put(ROOM, TEXT, 1, IV, CT);
  assert.equal(store.get(ROOM, TEXT).seq, 1);
});

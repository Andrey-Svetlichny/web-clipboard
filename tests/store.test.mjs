import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SEQ_JUMP_LIMIT, SeqConflict, Store } from '../server/store.mjs';

const ROOM = Buffer.alloc(16, 0x01);
const OTHER = Buffer.alloc(16, 0x02);
const IV = Buffer.alloc(12, 0x00);
const CT = Buffer.alloc(32, 0x03);

function freshStore(ttlSeconds = 3600) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clipboard-store-'));
  const file = path.join(dir, 'test.db');
  return { store: new Store(file, ttlSeconds), file };
}

test('round trip', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, 1, IV, CT);
  const record = store.get(ROOM);
  assert.equal(record.seq, 1);
  assert.deepEqual(record.iv, IV);
  assert.deepEqual(record.ct, CT);
  assert.equal(store.get(OTHER), null);
});

test('put replaces rather than accumulating', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, 1, IV, CT);
  store.put(ROOM, 2, IV, Buffer.from('newer'));
  assert.equal(store.get(ROOM).ct.toString(), 'newer');
});

test('the sequence must advance', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, 5, IV, CT);
  for (const stale of [1, 5]) {
    assert.throws(() => store.put(ROOM, stale, IV, CT), (error) => {
      assert.ok(error instanceof SeqConflict);
      assert.equal(error.current, 5);
      return true;
    });
  }
  store.put(ROOM, 6, IV, CT);
});

test('the sequence cannot be jumped to the ceiling', (t) => {
  // Without this an intercepting proxy bricks the room permanently: the room id is
  // derived from the pairing code, so it can never be reallocated.
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, 1, IV, CT);
  assert.throws(() => store.put(ROOM, 2 ** 52, IV, CT), SeqConflict);
  store.put(ROOM, 1 + SEQ_JUMP_LIMIT, IV, CT);
  assert.equal(store.get(ROOM).seq, 1 + SEQ_JUMP_LIMIT);
});

test('the first write is bounded too', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  assert.throws(() => store.put(ROOM, SEQ_JUMP_LIMIT + 1, IV, CT), SeqConflict);
  store.put(ROOM, SEQ_JUMP_LIMIT, IV, CT);
});

test('clear lets the sequence restart', (t) => {
  const { store } = freshStore();
  t.after(() => store.close());
  store.put(ROOM, 9, IV, CT);
  assert.equal(store.clear(ROOM), true);
  assert.equal(store.get(ROOM), null);
  store.put(ROOM, 1, IV, CT);
  assert.equal(store.get(ROOM).seq, 1);
});

test('expired records are invisible, then swept', (t) => {
  const { store } = freshStore(60);
  t.after(() => store.close());
  store.put(ROOM, 1, IV, CT, 1000);
  assert.notEqual(store.get(ROOM, 1030), null);
  assert.equal(store.get(ROOM, 1061), null);
  // An expired room reads as empty, so its sequence starts over too.
  store.put(ROOM, 1, IV, CT, 1061);
  assert.equal(store.sweep(1_000_000), 1);
});

test('the raw room key is never persisted', (t) => {
  const { store, file } = freshStore();
  store.put(ROOM, 1, IV, CT);
  store.close();
  const blob = readFileSync(file);
  assert.equal(blob.includes(ROOM), false);
  assert.ok(blob.includes(Buffer.from(createHash('sha256').update(ROOM).digest('hex'))));
});

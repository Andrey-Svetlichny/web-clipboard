// Cross-checks against web/index.html. The highest-value tests here: a key-schedule
// mismatch is silent at runtime and painful to debug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as reference from './reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS_PATH = path.join(ROOT, 'tests', 'vectors.json');
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

test('checksum and room key match the browser', () => {
  assert.ok(vectors.codes.length >= 4);
  for (const { body, code, room_key: roomKey } of vectors.codes) {
    assert.equal(code, body + reference.checkChar(body), body);
    assert.equal(reference.derive(code).roomKey.toString('hex'), roomKey, body);
  }
});

test('node:crypto can open what the browser sealed', () => {
  // Stronger than comparing key bytes: this pins the HKDF info strings, AES-GCM, and
  // the AAD layout all at once.
  assert.ok(vectors.records.length >= 8);
  for (const record of vectors.records) {
    const { roomKey, encKey } = reference.derive(record.code);
    assert.equal(reference.aad(roomKey, record.seq).toString('hex'), record.aad);
    const opened = reference.open(
      encKey, roomKey, record.seq,
      Buffer.from(record.iv, 'hex'), Buffer.from(record.ct, 'hex'));
    assert.equal(opened.toString('utf8'), record.plaintext);
  }
});

test('a record cannot be opened at another sequence number', () => {
  for (const record of vectors.records) {
    const { roomKey, encKey } = reference.derive(record.code);
    assert.throws(() => reference.open(
      encKey, roomKey, record.seq + 1,
      Buffer.from(record.iv, 'hex'), Buffer.from(record.ct, 'hex')));
  }
});

test('normalisation matches the browser', () => {
  for (const { input, output } of vectors.normalize) {
    assert.equal(reference.normalize(input), output, JSON.stringify(input));
  }
});

test('normalisation accepts every confusable spelling of one code', () => {
  const accepted = vectors.normalize.filter((c) => c.output !== null);
  // lowercase, hyphenated, spaced and O/I/L-substituted spellings all resolve
  assert.ok(accepted.length >= 6, `only ${accepted.length} spellings accepted`);
  assert.equal(new Set(accepted.map((c) => c.output)).size, 1);
  assert.ok(vectors.normalize.some((c) => c.output === null));
});

test('vectors.json is not stale', () => {
  // Regenerating and comparing means editing the page's crypto without refreshing the
  // vectors fails here, instead of passing against a stale file.
  const fresh = path.join(mkdtempSync(path.join(tmpdir(), 'note-')), 'vectors.json');
  execFileSync(process.execPath, [path.join(ROOT, 'tests', 'make_vectors.mjs'), fresh], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')), vectors);
});

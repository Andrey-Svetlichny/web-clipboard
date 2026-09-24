import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix } from '../web/qr.js';
import { decode, functionMap } from './qr_reader.mjs';

// Capacity in bytes for versions 1-6 at level M.
const CAPACITY = [14, 26, 42, 62, 84, 106];

test('a pairing link round trips through an independent reader', () => {
  for (const link of [
    'https://notes.example.com/#ABCDEFGHJKMNPQRSTVWX',
    'https://a.co/#ABCDEFGHJKMNPQRSTVWX',
    'https://a-very-long-subdomain.example.co.uk:8443/#ABCDEFGHJKMNPQRSTVWX',
  ]) {
    const code = qrMatrix(link);
    const read = decode(code);
    assert.equal(read.text, link);
    assert.equal(read.version, code.version);
  }
});

test('non-ascii survives byte mode', () => {
  const text = 'https://x.dev/#café—🔑';
  assert.equal(decode(qrMatrix(text)).text, text);
});

test('the smallest version that fits is chosen, and nothing larger encodes', () => {
  CAPACITY.forEach((capacity, index) => {
    const version = index + 1;
    const exact = qrMatrix('A'.repeat(capacity));
    assert.equal(exact.version, version);
    assert.equal(decode(exact).text, 'A'.repeat(capacity));

    const over = qrMatrix('A'.repeat(capacity + 1));
    if (version < 6) assert.equal(over.version, version + 1);
    // Past version 6 the page shows no QR rather than an unreadable one.
    else assert.equal(over, null);
  });
});

test('the fixed patterns are where a scanner looks for them', () => {
  const code = qrMatrix('https://notes.example.com/#ABCDEFGHJKMNPQRSTVWX');
  const { size, modules } = code;
  const at = (row, col) => modules[row * size + col];
  assert.equal(size, 17 + 4 * code.version);

  // Three finders: dark ring, light ring, dark core — and no fourth in the corner
  // that tells a scanner which way up the code is.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        const ring = row === 0 || row === 6 || col === 0 || col === 6;
        const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        assert.equal(at(top + row, left + col), ring || core ? 1 : 0,
          `finder at ${top},${left} module ${row},${col}`);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    assert.equal(at(6, i), i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }

  assert.equal(at(size - 8, 8), 1, 'the dark module');
});

test('every data module is covered by the reader, none left unwritten', () => {
  // A mismatch here would mean the encoder and reader disagree about which modules
  // carry data, which is the failure a round trip alone can hide.
  const code = qrMatrix('https://notes.example.com/#ABCDEFGHJKMNPQRSTVWX');
  const reserved = functionMap(code.size, code.version);
  let free = 0;
  for (const value of reserved) if (!value) free++;

  const [, ecCount, blocks, perBlock] = [0, 18, 2, 32];   // version 4 at level M
  assert.equal(code.version, 4);
  const codewordBits = blocks * (perBlock + ecCount) * 8;
  // Version 4 leaves 7 remainder bits that carry no codeword.
  assert.equal(free, codewordBits + 7);
});

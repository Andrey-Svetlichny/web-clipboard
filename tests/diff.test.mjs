import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../web/diff.js';

// Applying only the 'same'+'del' lines must reconstruct the old text, and only the
// 'same'+'add' lines must reconstruct the new text — true for any diff, not just the
// cases picked below, so this is the strongest general correctness check.
function reconstruct(ops, side) {
  const keep = side === 'old' ? ['same', 'del'] : ['same', 'add'];
  return ops.filter((op) => keep.includes(op.type)).map((op) => op.text).join('\n');
}

function assertRoundTrips(oldText, newText) {
  const ops = diffLines(oldText, newText);
  assert.equal(reconstruct(ops, 'old'), oldText);
  assert.equal(reconstruct(ops, 'new'), newText);
  return ops;
}

test('identical texts produce only same lines', () => {
  const ops = assertRoundTrips('a\nb\nc', 'a\nb\nc');
  assert.ok(ops.every((op) => op.type === 'same'));
});

test('pure addition', () => {
  const ops = assertRoundTrips('a\nb', 'a\nb\nc');
  assert.deepEqual(ops, [
    { type: 'same', text: 'a' },
    { type: 'same', text: 'b' },
    { type: 'add', text: 'c' },
  ]);
});

test('pure deletion', () => {
  const ops = assertRoundTrips('a\nb\nc', 'a\nc');
  assert.deepEqual(ops, [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'same', text: 'c' },
  ]);
});

test('a changed line is a del immediately followed by an add', () => {
  const ops = assertRoundTrips('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(ops, [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'B' },
    { type: 'same', text: 'c' },
  ]);
});

test('a reordered block round trips even if it is not shown as a move', () => {
  assertRoundTrips('a\nb\nc\nd', 'c\nd\na\nb');
});

test('empty to non-empty is a pure addition, not an addition plus a blank same-line', () => {
  const ops = assertRoundTrips('', 'a\nb');
  assert.deepEqual(ops, [
    { type: 'add', text: 'a' },
    { type: 'add', text: 'b' },
  ]);
});

test('non-empty to empty is a pure deletion', () => {
  const ops = assertRoundTrips('a\nb', '');
  assert.deepEqual(ops, [
    { type: 'del', text: 'a' },
    { type: 'del', text: 'b' },
  ]);
});

test('empty to empty produces no lines at all', () => {
  assert.deepEqual(diffLines('', ''), []);
});

test('a trailing newline is one more (empty) line, on either side', () => {
  const ops = assertRoundTrips('a\n', 'a');
  assert.deepEqual(ops, [
    { type: 'same', text: 'a' },
    { type: 'del', text: '' },
  ]);
});

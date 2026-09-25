// Line diff for showing what changed when another device updates the shared text.
//
// Myers' O(ND) algorithm, hand-rolled rather than pulled in as a dependency — same
// house style as tests/reference.mjs, which expands HKDF by hand from RFC 5869 instead
// of leaning on a library. A Map keyed by the diagonal k avoids the usual off-by-one
// array-offset bugs this algorithm is notorious for, including at the empty/empty edge.

function shortestEdit(a, b) {
  const n = a.length, m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v.get(k - 1) < v.get(k + 1))) {
        x = v.get(k + 1);
      } else {
        x = v.get(k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) return trace;
    }
  }
  return trace;
}

// Walks the trace back to front, turning it into [fromX, fromY, toX, toY] steps: a
// diagonal step is an unchanged line, an axis-aligned step is an insertion or deletion.
function backtrack(a, b, trace) {
  let x = a.length, y = b.length;
  const segments = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && v.get(k - 1) < v.get(k + 1))) ? k + 1 : k - 1;
    const prevX = v.get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      segments.push([x - 1, y - 1, x, y]);
      x--; y--;
    }
    if (d > 0) segments.push([prevX, prevY, x, y]);
    x = prevX; y = prevY;
  }
  return segments.reverse();
}

// A modified line is not detected specially: it comes out as a 'del' immediately
// followed by an 'add', which is what every line-diff viewer shows anyway.
export function diffLines(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const trace = shortestEdit(a, b);
  return backtrack(a, b, trace).map(([px, py, x, y]) => {
    if (x === px) return { type: 'add', text: b[py] };
    if (y === py) return { type: 'del', text: a[px] };
    return { type: 'same', text: a[px] };
  });
}

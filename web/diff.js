// Line diff for showing what changed when another device updates the shared text.
//
// Myers' O(ND) algorithm, written out rather than pulled in as a dependency. A Map keyed
// by the diagonal k avoids the array-offset off-by-ones this algorithm is notorious for,
// including at the empty/empty edge.

// The trace keeps one copy of the frontier per edit step, so memory grows with the square
// of the edit distance, and time with lines times distance. The use case is short secrets;
// these caps only stop a huge paste from stalling or exhausting the tab.
export const MAX_DIFF_LINES = 1_000;
export const MAX_DIFF_CHARS = 200_000;

// A file pasted from Windows compares equal to the same text typed elsewhere.
const splitLines = (text) => (text === '' ? [] : text.split(/\r?\n/));

const countLines = (text) => {
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
  return lines;
};

export function canDiff(oldText, newText) {
  return oldText.length + newText.length <= MAX_DIFF_CHARS
    && countLines(oldText) + countLines(newText) <= MAX_DIFF_LINES;
}

function shortestEdit(a, b) {
  const n = a.length;
  const m = b.length;
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
  let x = a.length;
  let y = b.length;
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
// followed by an 'add', which is what every line-diff viewer shows anyway. Callers check
// canDiff first; past the caps this still works, just slowly.
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const trace = shortestEdit(a, b);
  return backtrack(a, b, trace).map(([px, py, x, y]) => {
    if (x === px) return { type: 'add', text: b[py] };
    if (y === py) return { type: 'del', text: a[px] };
    return { type: 'same', text: a[px] };
  });
}

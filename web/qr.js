// Кодер QR: byte mode, уровень коррекции M, версии 1-6.
//
// Код спаривания — это весь секрет, поэтому картинку нельзя запросить у сервиса QR, а
// CSP не пустит библиотеку с CDN. Отсюда собственный кодер. Версии с 7-й потребовали бы
// блоков версии и сетки выравнивания; шести хватает на 106 байт — больше, чем любой
// домен плюс двадцатисимвольный код.


// [size, ec codewords per block, blocks, data codewords per block]. Every version
// through 6 at level M has equal-sized blocks, which keeps the interleave simple.
const QR_VERSIONS = [
  [21, 10, 1, 16],
  [25, 16, 1, 28],
  [29, 26, 1, 44],
  [33, 18, 2, 32],
  [37, 24, 2, 43],
  [41, 16, 4, 27],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

function rsGenerator(count) {
  let poly = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, count) {
  const gen = rsGenerator(count);
  const work = new Uint8Array(data.length + count);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j++) work[i + j] ^= gfMul(gen[j], coef);
  }
  return work.subarray(data.length);
}

// Mode indicator, length, payload, terminator, then the alternating pad bytes.
function qrCodewords(bytes, dataCodewords) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out[i >> 3] = byte;
  }
  for (let i = bits.length >> 3, pad = 0; i < dataCodewords; i++, pad++) {
    out[i] = pad % 2 ? 0x11 : 0xec;
  }
  return out;
}

const QR_MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;

function bchFormat(data) {
  let rest = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rest & (1 << (i + 10))) rest ^= G15 << i;
  }
  return ((data << 10) | rest) ^ G15_MASK;
}

// Runs of five, 2x2 blocks, finder-like sequences, and the light/dark balance.
function penalty(modules, size) {
  const at = (row, col) => modules[row * size + col];
  let score = 0;

  for (let a = 0; a < size; a++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const here = horizontal ? at(a, b) : at(b, a);
        const before = horizontal ? at(a, b - 1) : at(b - 1, a);
        if (here === before) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = at(row, col);
      if (value === at(row, col + 1) && value === at(row + 1, col)
        && value === at(row + 1, col + 1)) score += 3;
    }
  }

  const FINDER = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      let forward = true;
      let backward = true;
      for (let k = 0; k < 11; k++) {
        const value = at(a, b + k);
        if (value !== FINDER[k]) forward = false;
        if (value !== FINDER[10 - k]) backward = false;
      }
      if (forward || backward) score += 40;
      forward = true;
      backward = true;
      for (let k = 0; k < 11; k++) {
        const value = at(b + k, a);
        if (value !== FINDER[k]) forward = false;
        if (value !== FINDER[10 - k]) backward = false;
      }
      if (forward || backward) score += 40;
    }
  }

  let dark = 0;
  for (const value of modules) dark += value;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// Finder patterns, separators, timing, the dark module and — from version 2 — one
// alignment pattern. Returns the function-module map so data placement can skip it.
function qrFunctionPatterns(modules, size, version) {
  const reserved = new Uint8Array(size * size);
  const set = (row, col, value) => {
    modules[row * size + col] = value;
    reserved[row * size + col] = 1;
  };

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let row = -1; row <= 7; row++) {
      for (let col = -1; col <= 7; col++) {
        const r = top + row;
        const c = left + col;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const ring = row >= 0 && row <= 6 && col >= 0 && col <= 6
          && (row === 0 || row === 6 || col === 0 || col === 6);
        const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        set(r, c, ring || core ? 1 : 0);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  if (version >= 2) {
    const centre = size - 7;
    for (let row = -2; row <= 2; row++) {
      for (let col = -2; col <= 2; col++) {
        const edge = Math.abs(row) === 2 || Math.abs(col) === 2;
        const middle = row === 0 && col === 0;
        set(centre + row, centre + col, edge || middle ? 1 : 0);
      }
    }
  }

  set(size - 8, 8, 1);

  for (let i = 0; i <= 8; i++) {
    if (!reserved[8 * size + i]) set(8, i, 0);
    if (!reserved[i * size + 8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8 * size + (size - 1 - i)]) set(8, size - 1 - i, 0);
    if (!reserved[(size - 1 - i) * size + 8]) set(size - 1 - i, 8, 0);
  }
  return reserved;
}

function qrPlaceFormat(modules, size, mask) {
  const bits = bchFormat((0b00 << 3) | mask);   // 00 = level M
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) modules[i * size + 8] = bit;
    else if (i < 8) modules[(i + 1) * size + 8] = bit;
    else modules[(size - 15 + i) * size + 8] = bit;

    if (i < 8) modules[8 * size + (size - 1 - i)] = bit;
    else modules[8 * size + (15 - i - 1)] = bit;
  }
  modules[(size - 8) * size + 8] = 1;
}

// Zigzag from the bottom right, two columns at a time, skipping the timing column.
function qrPlaceData(modules, reserved, size, codewords) {
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (reserved[row * size + col]) continue;
        let value = 0;
        if (bit < codewords.length * 8) {
          value = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
        }
        bit++;
        modules[row * size + col] = value;
      }
    }
    upward = !upward;
  }
}

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = QR_VERSIONS.findIndex(([, , blocks, perBlock]) =>
    bytes.length <= blocks * perBlock - 2) + 1;
  if (version === 0) return null;

  const [size, ecCount, blocks, perBlock] = QR_VERSIONS[version - 1];
  const data = qrCodewords(bytes, blocks * perBlock);

  const dataBlocks = [];
  const ecBlocks = [];
  for (let i = 0; i < blocks; i++) {
    const block = data.subarray(i * perBlock, (i + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecCount));
  }
  const codewords = new Uint8Array(blocks * (perBlock + ecCount));
  let at = 0;
  for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) codewords[at++] = block[i];
  for (let i = 0; i < ecCount; i++) for (const block of ecBlocks) codewords[at++] = block[i];

  const base = new Uint8Array(size * size);
  const reserved = qrFunctionPatterns(base, size, version);
  qrPlaceData(base, reserved, size, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = base.slice();
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!reserved[row * size + col] && QR_MASKS[mask](row, col)) {
          modules[row * size + col] ^= 1;
        }
      }
    }
    qrPlaceFormat(modules, size, mask);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, modules };
  }
  return { size, version, modules: best.modules };
}

// Reads back what web/index.html's qrMatrix() produced: format info, unmask, de-interleave, then
// mode, length and payload. No error correction — it only has to read back what was
// written, which is enough to catch a wrong mask, format, interleave or placement.

const BLOCKS = {   // version -> [ec per block, blocks, data per block]
  1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44],
  4: [18, 2, 32], 5: [24, 2, 43], 6: [16, 4, 27],
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Rebuilt from the version alone, not borrowed from the encoder.
export function functionMap(size, version) {
  const reserved = new Uint8Array(size * size);
  const mark = (row, col) => {
    if (row >= 0 && row < size && col >= 0 && col < size) reserved[row * size + col] = 1;
  };
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let row = -1; row <= 7; row++) for (let col = -1; col <= 7; col++) mark(top + row, left + col);
  }
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  if (version >= 2) {
    for (let row = -2; row <= 2; row++) for (let col = -2; col <= 2; col++) {
      mark(size - 7 + row, size - 7 + col);
    }
  }
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  return reserved;
}

export function decode(matrix) {
  const { size, modules } = matrix;
  const version = (size - 17) / 4;
  const [ecCount, blocks, perBlock] = BLOCKS[version];

  // Format info, first copy: column 8 going down, then row 8 going left.
  let format = 0;
  for (let i = 14; i >= 0; i--) {
    let bit;
    if (i < 6) bit = modules[i * size + 8];
    else if (i < 8) bit = modules[(i + 1) * size + 8];
    else bit = modules[(size - 15 + i) * size + 8];
    format = (format << 1) | bit;
  }
  format ^= 0b101010000010010;
  const level = (format >> 13) & 0b11;
  const mask = (format >> 10) & 0b111;
  if (level !== 0b00) throw new Error(`expected level M, read ${level.toString(2)}`);
  if (mask > 7) throw new Error('bad mask');

  const reserved = functionMap(size, version);
  const clear = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      clear[index] = reserved[index] ? modules[index]
        : modules[index] ^ (MASKS[mask](row, col) ? 1 : 0);
    }
  }

  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (!reserved[row * size + col]) bits.push(clear[row * size + col]);
      }
    }
    upward = !upward;
  }

  const stream = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < stream.length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    stream[i] = byte;
  }

  // Undo the interleave: the first blocks*perBlock codewords are data, round robin.
  const data = new Uint8Array(blocks * perBlock);
  for (let i = 0, at = 0; i < perBlock; i++) {
    for (let block = 0; block < blocks; block++) data[block * perBlock + i] = stream[at++];
  }

  const mode = data[0] >> 4;
  if (mode !== 0b0100) throw new Error(`expected byte mode, read ${mode.toString(2)}`);
  const length = ((data[0] & 0x0f) << 4) | (data[1] >> 4);
  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    payload[i] = ((data[1 + i] & 0x0f) << 4) | (data[2 + i] >> 4);
  }
  return { version, mask, ecCount, text: new TextDecoder().decode(payload) };
}

// One record per room, in SQLite. See spec.md sections 3 and 4.
//
// The store never sees a room key in a form it can act on: callers pass the raw 16-byte
// key, it is hashed on the way in, and only the hash is persisted.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const SEQ_JUMP_LIMIT = 1000;

export class SeqConflict extends Error {
  constructor(current) {
    super(`sequence conflict (server at ${current})`);
    this.name = 'SeqConflict';
    this.current = current;
  }
}

export function roomHash(roomKey) {
  return createHash('sha256').update(roomKey).digest('hex');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  room_hash  TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  iv         BLOB    NOT NULL,
  ct         BLOB    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_expiry ON records (expires_at);
`;

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(path, ttlSeconds) {
    this.ttl = ttlSeconds;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.selectStmt = this.db.prepare(
      'SELECT seq, iv, ct FROM records WHERE room_hash = ? AND expires_at > ?');
    this.seqStmt = this.db.prepare(
      'SELECT seq FROM records WHERE room_hash = ? AND expires_at > ?');
    this.upsertStmt = this.db.prepare(
      'INSERT INTO records (room_hash, seq, iv, ct, expires_at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(room_hash) DO UPDATE SET seq = excluded.seq, iv = excluded.iv, '
      + 'ct = excluded.ct, expires_at = excluded.expires_at');
    this.deleteStmt = this.db.prepare('DELETE FROM records WHERE room_hash = ?');
    this.sweepStmt = this.db.prepare('DELETE FROM records WHERE expires_at <= ?');
  }

  close() {
    this.db.close();
  }

  sweep(at = now()) {
    return this.sweepStmt.run(at).changes;
  }

  get(roomKey, at = now()) {
    const row = this.selectStmt.get(roomHash(roomKey), at);
    if (!row) return null;
    return { seq: Number(row.seq), iv: Buffer.from(row.iv), ct: Buffer.from(row.ct) };
  }

  // Replaces the room's record. Throws SeqConflict if seq is out of range.
  put(roomKey, seq, iv, ct, at = now()) {
    const hash = roomHash(roomKey);
    const row = this.seqStmt.get(hash, at);
    const current = row ? Number(row.seq) : 0;
    if (!(current < seq && seq <= current + SEQ_JUMP_LIMIT)) throw new SeqConflict(current);
    this.upsertStmt.run(hash, seq, iv, ct, at + this.ttl);
    return seq;
  }

  // Deletes the record, so the next put starts from seq 1 again.
  clear(roomKey) {
    return this.deleteStmt.run(roomHash(roomKey)).changes > 0;
  }
}

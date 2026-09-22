// A room of numbered records, in SQLite. See spec.md sections 3 and 4.
//
// Master and detail: the room owns the lifetime, the records hang off it. Expiry is
// stored once, on the room, so the text and its attachments always die together — there
// is no per-record timestamp that could drift out of step with its siblings.
//
// Slot 0 holds the text and the manifest of attachments; slots 1..N hold one file each.
// The store neither knows nor cares what a slot means: to it they are opaque blobs.
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
CREATE TABLE IF NOT EXISTS rooms (
  room_hash  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  room_hash TEXT    NOT NULL REFERENCES rooms(room_hash) ON DELETE CASCADE,
  slot      INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  iv        BLOB    NOT NULL,
  ct        BLOB    NOT NULL,
  PRIMARY KEY (room_hash, slot)
);
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms (expires_at);
`;

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(path, ttlSeconds) {
    this.ttl = ttlSeconds;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Off by default in SQLite, and the cascade below is silently a no-op without it.
    this.db.exec('PRAGMA foreign_keys = ON');
    dropObsoleteSchema(this.db);
    this.db.exec(SCHEMA);

    this.selectStmt = this.db.prepare(
      'SELECT seq, iv, ct FROM records JOIN rooms USING (room_hash) '
      + 'WHERE room_hash = ? AND slot = ? AND expires_at > ?');
    this.seqStmt = this.db.prepare(
      'SELECT seq FROM records JOIN rooms USING (room_hash) '
      + 'WHERE room_hash = ? AND slot = ? AND expires_at > ?');
    this.touchStmt = this.db.prepare(
      'INSERT INTO rooms (room_hash, expires_at) VALUES (?, ?) '
      + 'ON CONFLICT(room_hash) DO UPDATE SET expires_at = excluded.expires_at');
    this.upsertStmt = this.db.prepare(
      'INSERT INTO records (room_hash, slot, seq, iv, ct) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(room_hash, slot) DO UPDATE SET seq = excluded.seq, '
      + 'iv = excluded.iv, ct = excluded.ct');
    this.deleteRoomStmt = this.db.prepare('DELETE FROM rooms WHERE room_hash = ?');
    this.deleteSlotStmt = this.db.prepare(
      'DELETE FROM records WHERE room_hash = ? AND slot = ?');
    this.sweepStmt = this.db.prepare('DELETE FROM rooms WHERE expires_at <= ?');
  }

  close() {
    this.db.close();
  }

  sweep(at = now()) {
    return this.sweepStmt.run(at).changes;
  }

  get(roomKey, slot, at = now()) {
    const row = this.selectStmt.get(roomHash(roomKey), slot, at);
    if (!row) return null;
    return { seq: Number(row.seq), iv: Buffer.from(row.iv), ct: Buffer.from(row.ct) };
  }

  // Replaces one slot. Throws SeqConflict if seq is out of range. Any write extends the
  // whole room, so attachments never expire out from under the text that names them.
  put(roomKey, slot, seq, iv, ct, at = now()) {
    const hash = roomHash(roomKey);
    const row = this.seqStmt.get(hash, slot, at);
    const current = row ? Number(row.seq) : 0;
    if (!(current < seq && seq <= current + SEQ_JUMP_LIMIT)) throw new SeqConflict(current);
    this.touchStmt.run(hash, at + this.ttl);
    this.upsertStmt.run(hash, slot, seq, iv, ct);
    return seq;
  }

  // With a slot, drops that record alone. Without one, drops the room and every record
  // in it, so the next put starts from seq 1 again.
  clear(roomKey, slot = null) {
    const hash = roomHash(roomKey);
    if (slot === null) return this.deleteRoomStmt.run(hash).changes > 0;
    return this.deleteSlotStmt.run(hash, slot).changes > 0;
  }
}

// An older deployment has a flat records table with room_hash as the primary key and no
// rooms table at all. CREATE TABLE IF NOT EXISTS would leave it in place and every put
// would then fail on the missing column, so it is dropped instead: everything here is
// ephemeral by design, which is exactly why there is no migration to write.
function dropObsoleteSchema(db) {
  const columns = db.prepare('PRAGMA table_info(records)').all();
  if (columns.length > 0 && !columns.some((column) => column.name === 'slot')) {
    db.exec('DROP TABLE IF EXISTS records');
    db.exec('DROP TABLE IF EXISTS rooms');
  }
}

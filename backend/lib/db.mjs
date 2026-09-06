import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || '/config'
const DB_FILE = path.join(CONFIG_DIR, 'library.db')

const SCHEMA_VERSION = 1

let _db = null

// Single shared SQLite handle (node:sqlite, synchronous) used for queue
// persistence, download history, and incremental library tracking. Callers
// must keep operations short — everything runs on the main event loop.
export function getDb() {
  if (_db) return _db
  const db = new DatabaseSync(DB_FILE)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  _db = db
  return _db
}

export function getDbFile() {
  return DB_FILE
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS queue_jobs (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_jobs_seq ON queue_jobs(seq);

    CREATE TABLE IF NOT EXISTS download_history (
      id TEXT PRIMARY KEY,
      finished_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_finished ON download_history(finished_at);

    CREATE TABLE IF NOT EXISTS library_dirs (
      path TEXT PRIMARY KEY,
      parent TEXT,
      mtime INTEGER NOT NULL,
      kind TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_library_dirs_parent ON library_dirs(parent);

    CREATE TABLE IF NOT EXISTS library_files (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,
      artist_name TEXT,
      album_name TEXT,
      song_name TEXT,
      song_key TEXT,
      album_key TEXT,
      isrc TEXT,
      upc TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_library_files_parent ON library_files(parent);
    CREATE INDEX IF NOT EXISTS idx_library_files_song_key ON library_files(song_key);
    CREATE INDEX IF NOT EXISTS idx_library_files_album_key ON library_files(album_key);
  `)
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION))
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row?.value ?? null
}

export function setMeta(key, value) {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, String(value))
}

export function inTransaction(fn) {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const result = fn(db)
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw err
  }
}

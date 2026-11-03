import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type Database = BetterSQLite3Database<typeof schema>

/**
 * Hand-written DDL that drizzle-kit cannot generate: the FTS5 virtual table
 * indexing scenario text (plus the owning feature name) and the triggers that
 * keep it in sync with the `scenarios` table. The FTS rowid mirrors the
 * scenario id so triggers can address index rows directly.
 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS scenarios_fts USING fts5(
  context,
  action,
  outcome,
  feature_name
);

CREATE TRIGGER IF NOT EXISTS scenarios_fts_insert AFTER INSERT ON scenarios BEGIN
  INSERT INTO scenarios_fts (rowid, context, action, outcome, feature_name)
  SELECT new.id, new.context, new.action, new.outcome, f.name
  FROM features f
  WHERE f.id = new.featureId;
END;

CREATE TRIGGER IF NOT EXISTS scenarios_fts_update AFTER UPDATE ON scenarios BEGIN
  DELETE FROM scenarios_fts WHERE rowid = old.id;
  INSERT INTO scenarios_fts (rowid, context, action, outcome, feature_name)
  SELECT new.id, new.context, new.action, new.outcome, f.name
  FROM features f
  WHERE f.id = new.featureId;
END;

CREATE TRIGGER IF NOT EXISTS scenarios_fts_delete AFTER DELETE ON scenarios BEGIN
  DELETE FROM scenarios_fts WHERE rowid = old.id;
END;
`

interface DBHandle {
  db: Database
  sqlite: Database.Database
}

let handle: DBHandle | null = null

/**
 * Returns the process-wide database singleton, creating it on first call:
 * opens better-sqlite3 at `DATABASE_PATH`, applies the generated drizzle
 * migrations, then creates `scenarios_fts` and its sync triggers.
 * Reads the env var lazily, so it must be set before the first call.
 */
export function getDB(): Database {
  if (!handle) {
    handle = createDB()
  }
  return handle.db
}

/**
 * Closes the current connection and clears the singleton so the next getDB()
 * call creates a fresh instance. Intended for tests: each test can call
 * resetDB() in a beforeEach to get an isolated `DATABASE_PATH=:memory:`
 * database without cross-test leakage.
 */
export function resetDB(): void {
  if (handle) {
    handle.sqlite.close()
    handle = null
  }
}

function createDB(): DBHandle {
  const path = process.env.DATABASE_PATH
  if (!path) {
    throw new Error('DATABASE_PATH is not set; it must point to the SQLite database file (or ":memory:" in tests)')
  }

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new Database(path)
  const db = drizzle(sqlite, { schema })

  migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations/', import.meta.url)) })
  sqlite.exec(FTS_DDL)

  return { db, sqlite }
}

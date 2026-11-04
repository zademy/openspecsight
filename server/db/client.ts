import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SQLite from 'better-sqlite3'
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

-- The insert/update triggers copy features.name into feature_name at write
-- time, so a feature rename would leave the index stale; re-index every
-- scenario of the renamed feature.
CREATE TRIGGER IF NOT EXISTS features_fts_rename AFTER UPDATE OF name ON features BEGIN
  DELETE FROM scenarios_fts
  WHERE rowid IN (SELECT id FROM scenarios WHERE featureId = old.id);
  INSERT INTO scenarios_fts (rowid, context, action, outcome, feature_name)
  SELECT s.id, s.context, s.action, s.outcome, new.name
  FROM scenarios s
  WHERE s.featureId = new.id;
END;
`

interface DBHandle {
  db: Database
  sqlite: SQLite.Database
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

/**
 * Locates the drizzle migrations folder at runtime. The module can run from
 * three layouts, and none of them can be hardcoded:
 * 1. Source layout (unit tests, `import.meta.url` next to `migrations/`).
 * 2. Bundled dev builds (`nuxt dev` runs server code from `.nuxt/dev/`).
 * 3. Production builds (`.output/server/`), where the Nuxt build copies the
 *    migrations next to the server entry (see nitro.hooks.compiled in
 *    nuxt.config.ts).
 * Walking up from this module covers 2 and 3 without depending on the cwd.
 */
function resolveMigrationsFolder(): string {
  const hasJournal = (folder: string) => existsSync(join(folder, 'meta', '_journal.json'))

  const here = dirname(fileURLToPath(import.meta.url))

  // 1. Source layout: client.ts lives inside server/db, next to migrations/.
  const source = join(here, 'migrations')
  if (hasJournal(source)) {
    return source
  }

  // 2+3. Walk ancestors looking for the project's `server/db/migrations`
  // (dev bundles) or the bundled `db/migrations` (production output).
  for (let dir = here; ; dir = dirname(dir)) {
    for (const candidate of [join(dir, 'server', 'db', 'migrations'), join(dir, 'db', 'migrations')]) {
      if (hasJournal(candidate)) {
        return candidate
      }
    }
    if (dir === dirname(dir)) {
      break
    }
  }

  throw new Error('Drizzle migrations folder not found; expected server/db/migrations in the project or bundled next to the server entry')
}

function createDB(): DBHandle {
  const path = process.env.DATABASE_PATH
  if (!path) {
    throw new Error('DATABASE_PATH is not set; it must point to the SQLite database file (or ":memory:" in tests)')
  }

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const sqlite = new SQLite(path)
  const db = drizzle(sqlite, { schema })

  migrate(db, { migrationsFolder: resolveMigrationsFolder() })
  sqlite.exec(FTS_DDL)

  return { db, sqlite }
}

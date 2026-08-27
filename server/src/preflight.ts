import Database from 'better-sqlite3';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb,
  inspectLegacyTrialSchema,
  RETIRED_DATA_COMPACTION_TASK,
} from './db.js';
import { loadEnv } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
interface DatabaseInspection {
  integrity: string;
  legacyMigrationRequired: boolean;
  pendingSlideDeletionCount: number;
  pendingCompactionCount: number;
}

function hasTable(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name)
  );
}

function inspectOpenDatabase(database: Database.Database): DatabaseInspection {
  database.pragma('query_only = ON');
  const integrityRows = database.pragma('integrity_check') as { integrity_check?: string }[];
  const integrity = integrityRows.map((row) => row.integrity_check ?? '').join(', ');
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity || '(no result)'}`);
  }

  const legacyMigrationRequired = inspectLegacyTrialSchema(database).migrationRequired;
  const pendingSlideDeletionCount = hasTable(database, 'pending_slide_deletions')
    ? (database
        .prepare('SELECT COUNT(*) AS count FROM pending_slide_deletions')
        .get() as { count: number }).count
    : 0;
  const pendingCompactionCount = hasTable(database, 'database_maintenance_tasks')
    ? (database
        .prepare('SELECT COUNT(*) AS count FROM database_maintenance_tasks WHERE task = ?')
        .get(RETIRED_DATA_COMPACTION_TASK) as { count: number }).count
    : 0;

  return {
    integrity,
    legacyMigrationRequired,
    pendingSlideDeletionCount,
    pendingCompactionCount,
  };
}

async function assertExistingPath(target: string, label: string, kind: 'file' | 'directory'): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${target}`);
    }
    throw error;
  }
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`${label} is not a ${kind}: ${target}`);
  }
  await fsp.access(target, fs.constants.R_OK);
  let writable = true;
  try {
    await fsp.access(target, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  console.log(`ok ${label}: readable${writable ? ' + writable' : ' (readonly)'} (${target})`);
}

async function assertClientBuild(): Promise<void> {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  const indexPath = path.join(clientDist, 'index.html');
  const assetsPath = path.join(clientDist, 'assets');
  await fsp.access(indexPath, fs.constants.R_OK);
  const assets = await fsp.readdir(assetsPath);
  if (!assets.some((file) => /^index-.*\.js$/.test(file))) {
    throw new Error(`client build is missing the main JS chunk in ${assetsPath}`);
  }
  console.log(`ok client build: ${clientDist}`);
}

function sameFileSnapshot(
  left: fs.BigIntStats,
  right: fs.BigIntStats
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function existingSqliteSidecars(databasePath: string): Promise<string[]> {
  const candidates = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return existing;
}

/**
 * A closed WAL-mode database can be perfectly readable while SQLite itself
 * cannot open it in a directory that forbids creation of the transient -shm
 * file. When there are no sidecars, take a guarded filesystem snapshot into
 * the disposable directory instead. Metadata and sidecars are checked on both
 * sides of the read; integrity and migration are still validated with SQLite
 * only against that clone.
 */
async function cloneQuiescentReadonlyDatabase(
  databasePath: string,
  clonePath: string
): Promise<void> {
  const sidecarsBefore = await existingSqliteSidecars(databasePath);
  if (sidecarsBefore.length > 0) {
    throw new Error(
      `readonly database requires a quiesced snapshot, but SQLite sidecars are present: ` +
        sidecarsBefore.map((file) => path.basename(file)).join(', ')
    );
  }

  const before = await fsp.stat(databasePath, { bigint: true });
  const bytes = await fsp.readFile(databasePath);
  const after = await fsp.stat(databasePath, { bigint: true });
  const sidecarsAfter = await existingSqliteSidecars(databasePath);
  if (
    !sameFileSnapshot(before, after) ||
    BigInt(bytes.byteLength) !== before.size ||
    sidecarsAfter.length > 0
  ) {
    throw new Error('database changed while taking the readonly snapshot; stop writers and retry');
  }
  await fsp.writeFile(clonePath, bytes, { flag: 'wx' });
}

async function inspectAndValidateClone(databasePath: string): Promise<DatabaseInspection> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fluent-preflight-'));
  const clonePath = path.join(tmpDir, 'app.db');
  try {
    // SQLite's online backup API creates a transactionally consistent clone
    // across WAL/checkpoint activity. The source connection is readonly and
    // query_only; all schema migration happens only on the temporary clone.
    const source = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      try {
        await source.backup(clonePath);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_READONLY' && code !== 'SQLITE_READONLY_DIRECTORY' && code !== 'SQLITE_CANTOPEN') {
          throw error;
        }
        await fsp.rm(clonePath, { force: true });
        await cloneQuiescentReadonlyDatabase(databasePath, clonePath);
      }
    } finally {
      source.close();
    }

    // Inspect the exact transactional snapshot that will be migrated, so live
    // writes cannot make the report and validation refer to different commits.
    const inspectionCopy = new Database(clonePath, { fileMustExist: true });
    let inspection: DatabaseInspection;
    try {
      inspection = inspectOpenDatabase(inspectionCopy);
    } finally {
      inspectionCopy.close();
    }

    const clone = initDb(clonePath).database;
    try {
      const migrated = inspectOpenDatabase(clone);
      if (migrated.legacyMigrationRequired) {
        throw new Error('temporary migration validation left retired schema behind');
      }
    } finally {
      clone.close();
    }
    console.log('ok database: readonly online backup + temporary migration validation');
    return inspection;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const strictCurrent = process.argv.includes('--strict-current');
  await assertClientBuild();
  await assertExistingPath(path.dirname(env.DATABASE_PATH), 'database directory', 'directory');
  await assertExistingPath(env.DATABASE_PATH, 'database', 'file');
  await assertExistingPath(env.UPLOADS_DIR, 'uploads directory', 'directory');
  const inspection = await inspectAndValidateClone(env.DATABASE_PATH);

  if (strictCurrent) {
    const outstanding = [
      inspection.legacyMigrationRequired && 'legacy schema migration',
      inspection.pendingSlideDeletionCount > 0 && `${inspection.pendingSlideDeletionCount} slide deletion(s)`,
      inspection.pendingCompactionCount > 0 && `${inspection.pendingCompactionCount} data compaction task(s)`,
    ].filter(Boolean);
    if (outstanding.length > 0) {
      throw new Error(`strict current-state check failed: ${outstanding.join(', ')}`);
    }
  }

  if (process.env.NODE_ENV === 'production' && !env.PUBLIC_ORIGIN) {
    console.warn('warning PUBLIC_ORIGIN is not set; same-host HTML decks are still rejected from request Host.');
  }
  console.log(JSON.stringify({
    ok: true,
    strictCurrent,
    databasePath: env.DATABASE_PATH,
    uploadsDir: env.UPLOADS_DIR,
    database: inspection,
    port: env.PORT,
    trustProxy: env.TRUST_PROXY,
    publicOrigin: env.PUBLIC_ORIGIN,
  }));
}

main().catch((error) => {
  console.error(`preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

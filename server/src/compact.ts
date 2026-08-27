import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { completeRetiredDataCompaction, RETIRED_DATA_COMPACTION_TASK } from './db.js';
import { loadEnv } from './env.js';

function fileSize(file: string): bigint {
  try {
    return fs.statSync(file, { bigint: true }).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
    throw error;
  }
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name)
  );
}

function availableBytes(directory: string): bigint {
  const disk = fs.statfsSync(directory, { bigint: true });
  return disk.bavail * disk.bsize;
}

function main(): void {
  const { DATABASE_PATH } = loadEnv();
  if (fileSize(DATABASE_PATH) === 0n) {
    throw new Error(`database does not exist or is empty: ${DATABASE_PATH}`);
  }

  // Force SQLite's transient VACUUM database onto the checked data
  // filesystem. This avoids approving space on an unrelated system temp disk.
  const databaseDirectory = path.dirname(DATABASE_PATH);
  process.env.SQLITE_TMPDIR = databaseDirectory;
  process.env.TMPDIR = databaseDirectory;
  const database = new Database(DATABASE_PATH, { fileMustExist: true });
  try {
    database.pragma('busy_timeout = 5000');
    if (!tableExists(database, 'database_maintenance_tasks')) {
      console.log(JSON.stringify({ ok: true, compacted: false, reason: 'no maintenance table' }));
      return;
    }
    const pending = database
      .prepare('SELECT 1 FROM database_maintenance_tasks WHERE task = ?')
      .get(RETIRED_DATA_COMPACTION_TASK);
    if (!pending) {
      console.log(JSON.stringify({ ok: true, compacted: false, reason: 'no pending compaction' }));
      return;
    }

    // Exclusive locking keeps a running app or another maintenance process
    // from racing the checkpoint/VACUUM sequence. Operators should still stop
    // the service before invoking this command.
    database.pragma('locking_mode = EXCLUSIVE');
    database.exec('BEGIN EXCLUSIVE; COMMIT;');

    // Another maintenance process may have completed while this process was
    // waiting for the exclusive lock. Recheck under exclusive ownership so a
    // stale precheck cannot trigger a second VACUUM.
    const stillPending = database
      .prepare('SELECT 1 FROM database_maintenance_tasks WHERE task = ?')
      .get(RETIRED_DATA_COMPACTION_TASK);
    if (!stillPending) {
      console.log(JSON.stringify({ ok: true, compacted: false, reason: 'no pending compaction' }));
      return;
    }

    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as {
      busy: number;
      log: number;
      checkpointed: number;
    }[];
    if (!checkpoint[0] || checkpoint[0].busy !== 0) {
      throw new Error('cannot compact while the WAL checkpoint is busy; stop all application instances and retry');
    }

    // Check headroom after the checkpoint while the database is exclusively
    // owned. SQLite documents that VACUUM can require up to twice the original
    // DB size; include any remaining WAL and use bigint arithmetic throughout.
    const databaseBytes = fileSize(DATABASE_PATH);
    const walBytes = fileSize(`${DATABASE_PATH}-wal`);
    const requiredFreeBytes = databaseBytes * 2n + walBytes;
    const databaseAvailableBytes = availableBytes(databaseDirectory);
    if (databaseAvailableBytes < requiredFreeBytes) {
      throw new Error(
        `insufficient free space for compaction: need at least ${requiredFreeBytes} bytes, ` +
          `${databaseAvailableBytes} bytes available on the database filesystem`
      );
    }

    database.pragma('secure_delete = ON');
    database.exec('VACUUM');
    const finalCheckpoint = database.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (!finalCheckpoint[0] || finalCheckpoint[0].busy !== 0) {
      throw new Error('compaction completed but the final WAL checkpoint is busy; maintenance remains queued');
    }
    completeRetiredDataCompaction(database);
    console.log(JSON.stringify({ ok: true, compacted: true, databasePath: DATABASE_PATH }));
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`database compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

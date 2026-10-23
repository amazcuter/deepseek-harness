/**
 * Moving one project database between files, keeping exactly one authoritative
 * copy at every step.
 *
 * The source is checkpointed first, so its write-ahead log is folded into the
 * file being copied. The destination then appears only as the atomic rename of
 * a fully written and synced copy; an interrupted move therefore leaves the
 * source as the only database, and a move that reached the rename leaves the
 * destination as the authoritative one.
 *
 * @module @metaworkflow/workflow-project-store/relocate
 */

import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { OWNER_ONLY_DIRECTORY_MODE } from './open.ts'
import { openProjectDatabase } from './project-database.ts'

/** Suffix of the staging file a copy is written to before the atomic rename. */
const STAGING_SUFFIX = '.moving'

/**
 * Move one project database to a new location.
 *
 * The write-ahead log and shared-memory files next to the source are dropped
 * with it: the log is checkpointed into the copied file first, and the memory
 * file is rebuilt by the next connection.
 * @param source - absolute path of the database being moved.
 * @param target - absolute path the database must end up at; missing parent directories are created owner-only.
 * @returns resolution once the copy is durable, renamed into place, and the source file removed.
 * @throws {@link WorkflowProjectStoreError} from the open protocol when the source
 * is not this store's database, and any filesystem failure of the copy, sync,
 * rename, or removal; the source stays the only database until the rename.
 */
export async function moveProjectDatabase(source: string, target: string): Promise<void> {
  await checkpointWrites(source)
  await mkdir(dirname(target), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
  const staging = `${target}${STAGING_SUFFIX}`
  await copyFile(source, staging)
  await syncFile(staging)
  await rename(staging, target)
  await rm(source, { force: true })
  await rm(`${source}-wal`, { force: true })
  await rm(`${source}-shm`, { force: true })
}

/**
 * Fold a source database's write-ahead log into its main file.
 * @param path - database about to be copied.
 * @returns resolution once every committed transaction is in the main file.
 */
async function checkpointWrites(path: string): Promise<void> {
  const db = await openProjectDatabase(path)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

/**
 * Flush one file's bytes to the medium before it becomes the authoritative copy.
 * @param path - file to sync.
 * @returns resolution once the handle is closed.
 */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

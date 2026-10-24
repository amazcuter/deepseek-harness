/**
 * The durable coordinator-session record: which persistent Session serves one
 * project's coordination.
 *
 * The record lives in the project database's `schema_meta` compatibility row
 * beside the runs it coordinates, so every process that opens the project
 * resumes the same conversation instead of starting a second coordinator. The
 * coordinator owns this row and no other module reads it.
 *
 * @module @metaworkflow/workflow-coordinator/session-store
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { brandString } from '@metaworkflow/brand'
import type { SessionId } from '@metaworkflow/session'

/** `schema_meta` key holding the coordinator session id of one project. */
export const COORDINATOR_SESSION_KEY = 'coordinator/session'

/** One `schema_meta` row as `node:sqlite` hands it back. */
interface MetaRow extends Record<string, SQLOutputValue> {
  readonly value: string
}

/**
 * Read the coordinator session one project records.
 * @param db - the project's connection, inside the caller's transaction.
 * @returns the recorded session id, or `undefined` when no coordinator has opened this project.
 * @throws `Error` when the stored row is empty, because an empty id would
 * resume nothing.
 */
export function selectCoordinatorSession(db: DatabaseSync): SessionId | undefined {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(COORDINATOR_SESSION_KEY) as MetaRow | undefined
  if (row === undefined) return undefined
  if (row.value.length === 0) {
    throw new Error(`the coordinator session record under "${COORDINATOR_SESSION_KEY}" is empty`)
  }
  return brandString<SessionId>(row.value)
}

/**
 * Record the coordinator session one project continues.
 * @param db - the project's connection, inside the caller's transaction.
 * @param sessionId - session the coordinator resumes.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function saveCoordinatorSession(db: DatabaseSync, sessionId: SessionId): void {
  db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(COORDINATOR_SESSION_KEY, sessionId)
}

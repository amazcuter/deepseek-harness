/**
 * The durable pending-decision record: the answer that woke one waiting
 * activation, held until the resumed attempt commits.
 *
 * The answer lives in the project database's `schema_meta` compatibility row
 * beside the activations it resumes, so a coordinator answering during one
 * process and a run executing in another — or in a later one — hand the node
 * the same answer. The scheduler owns this row and no other module reads it.
 *
 * @module @metaworkflow/workflow-scheduler/pending-decisions
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { JsonValue } from '@metaworkflow/util-values'

/**
 * `schema_meta` key holding the pending decisions. The value is a JSON object
 * from an activation id to the answer the coordinator gave it.
 */
export const PENDING_DECISIONS_KEY = 'scheduler/pending-decisions'

/** One `schema_meta` row as `node:sqlite` hands it back. */
interface MetaRow extends Record<string, SQLOutputValue> {
  readonly value: string
}

/**
 * Read the whole pending-decision mapping of one project.
 * @param db - the project's connection, inside the caller's transaction.
 * @returns the mapping; empty when no activation is waiting for an answer.
 * @throws `Error` when the stored row is not a JSON object, because the mapping
 * decides what a resumed node receives.
 */
function selectPendingDecisions(db: DatabaseSync): Readonly<Record<string, JsonValue>> {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(PENDING_DECISIONS_KEY) as MetaRow | undefined
  if (row === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch (error: unknown) {
    throw new Error(`the pending-decision record under "${PENDING_DECISIONS_KEY}" is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the pending-decision record under "${PENDING_DECISIONS_KEY}" is not a JSON object`)
  }
  return parsed as Readonly<Record<string, JsonValue>>
}

/**
 * Write the whole pending-decision mapping of one project.
 * @param db - the project's connection, inside the caller's transaction.
 * @param mapping - the mapping to store.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
function savePendingDecisions(db: DatabaseSync, mapping: Readonly<Record<string, JsonValue>>): void {
  db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(PENDING_DECISIONS_KEY, JSON.stringify(mapping))
}

/**
 * The answer one waiting activation resumes with.
 * @param db - the project's connection, inside the caller's transaction.
 * @param activationId - activation being executed.
 * @returns the answer, or `undefined` when the activation was never resumed.
 * @throws `Error` when the stored record is corrupt.
 */
export function selectPendingDecision(db: DatabaseSync, activationId: string): JsonValue | undefined {
  return selectPendingDecisions(db)[activationId]
}

/**
 * Store the answer one waiting activation resumes with.
 * @param db - the project's connection, inside the caller's transaction.
 * @param activationId - activation being resumed.
 * @param decision - the answer the coordinator gave.
 * @returns nothing; the row is visible to later reads after the caller commits.
 * @throws `Error` when the stored record is corrupt.
 */
export function savePendingDecision(db: DatabaseSync, activationId: string, decision: JsonValue): void {
  savePendingDecisions(db, { ...selectPendingDecisions(db), [activationId]: decision })
}

/**
 * Drop the answer of one activation once its attempt committed.
 * @param db - the project's connection, inside the caller's transaction.
 * @param activationId - activation whose answer was consumed.
 * @returns nothing; an activation with no recorded answer needs no write.
 * @throws `Error` when the stored record is corrupt.
 */
export function clearPendingDecision(db: DatabaseSync, activationId: string): void {
  const mapping = selectPendingDecisions(db)
  if (mapping[activationId] === undefined) return
  const { [activationId]: _consumed, ...rest } = mapping
  savePendingDecisions(db, rest)
}

/**
 * One atomic write batch on an open connection.
 *
 * @module @metaworkflow/workflow-project-store/transaction
 */

import type { DatabaseSync } from 'node:sqlite'

/**
 * Run one write batch inside `BEGIN IMMEDIATE … COMMIT`.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so a batch cannot fail
 * halfway on lock upgrade. A throwing body rolls the whole batch back and the
 * marker statement leaves no trace behind.
 * @param db - open connection that holds the write lock for the batch.
 * @param body - statements to run; returning normally commits, throwing rolls back.
 * @returns the body's result after the commit.
 */
export function runTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  let result: T
  try {
    result = body()
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
  db.exec('COMMIT')
  return result
}

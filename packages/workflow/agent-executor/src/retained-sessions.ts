/**
 * The durable retained-session mapping: which session a `retained` agent node
 * resumes on its next activation.
 *
 * The mapping lives in the project database's `schema_meta` compatibility row,
 * beside the runs and attempts that own it, so a later activation — in this
 * process or after a restart — finds the same session without a layout change to
 * the project database. The executor owns this row and no other module reads it.
 *
 * @module @metaworkflow/workflow-agent-executor/retained-sessions
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/**
 * `schema_meta` key holding the retained-session mapping. The value is a JSON
 * object from {@link retainedSessionKey} to a session id.
 */
export const RETAINED_SESSIONS_KEY = 'agent-executor/node-sessions'

/** One `schema_meta` row as `node:sqlite` hands it back. */
interface MetaRow extends Record<string, SQLOutputValue> {
  readonly value: string
}

/**
 * The mapping key of one node in one run.
 *
 * The run is part of the key, so two runs of the same definition never share a
 * conversation, and a loop iteration is not: `retained` means the node keeps
 * one conversation across the activations of the run that owns it.
 * @param runId - run the activation belongs to.
 * @param nodeId - definition node the activation executes.
 * @returns the stable key of the node's retained session.
 */
export function retainedSessionKey(runId: string, nodeId: string): string {
  return `${runId}/${nodeId}`
}

/**
 * Read the whole retained-session mapping of one project.
 * @param db - the project's connection, inside the caller's transaction.
 * @returns the mapping; empty when this deployment never recorded one.
 * @throws `Error` when the stored row is not a JSON object of string session ids,
 * because the mapping decides which conversation a node continues.
 */
export function selectRetainedSessions(db: DatabaseSync): Readonly<Record<string, string>> {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(RETAINED_SESSIONS_KEY) as MetaRow | undefined
  if (row === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(row.value)
  } catch (error: unknown) {
    throw new Error(`the retained-session record under "${RETAINED_SESSIONS_KEY}" is not valid JSON`, { cause: error })
  }
  return validateMapping(parsed)
}

/**
 * Record the session one node resumes on its next activation.
 * @param db - the project's connection, inside the caller's transaction.
 * @param key - the node's mapping key.
 * @param sessionId - session the node continues.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function upsertRetainedSession(db: DatabaseSync, key: string, sessionId: string): void {
  const mapping = { ...selectRetainedSessions(db), [key]: sessionId }
  db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(RETAINED_SESSIONS_KEY, JSON.stringify(mapping))
}

/**
 * Accept only a plain object whose values are non-empty session ids.
 * @param parsed - value decoded from the stored row.
 * @returns the validated mapping.
 * @throws `Error` when the value is not a plain object of non-empty strings.
 */
function validateMapping(parsed: unknown): Readonly<Record<string, string>> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the retained-session record under "${RETAINED_SESSIONS_KEY}" is not a JSON object`)
  }
  const mapping: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`the retained-session record under "${RETAINED_SESSIONS_KEY}" has a non-string session for "${key}"`)
    }
    mapping[key] = value
  }
  return mapping
}

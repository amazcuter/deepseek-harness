/**
 * The decision-request row protocol over one project database: one row per
 * question a node asks the project coordinator, and the answer that resumes it.
 *
 * A request carries the activation and attempt that asked, so a reopened
 * project maps every pending question back to the work waiting on it; the
 * response stays `NULL` until the coordinator answers, and an answer never
 * replaces an earlier one. Statements take an open `DatabaseSync` so a caller
 * commits its own batch through `ctx.mwfProjectStore.transact`.
 *
 * @module @metaworkflow/workflow-project-store/decisions
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { JsonValue } from '@metaworkflow/util-values'
import { brandString } from '@metaworkflow/brand'
import { WorkflowProjectStoreError } from './errors.ts'
import type {
  ActivationId,
  AttemptId,
  DecisionAnswer,
  DecisionPayload,
  DecisionRecord,
  DecisionRequestInput,
  RunId,
} from './types.ts'

/** One joined decision row in column declaration order. */
interface DecisionDbRow extends Record<string, SQLOutputValue> {
  readonly request_id: string
  readonly run_id: string
  readonly activation_id: string
  readonly node_id: string
  readonly attempt_id: string | null
  readonly payload_json: string
  readonly response_json: string | null
  readonly created_at: number
  readonly answered_at: number | null
}

/**
 * Columns every decision read selects. The activation join supplies the run and
 * node a pending question belongs to, which a caller needs to resume it.
 */
const DECISION_COLUMNS = `d.request_id AS request_id,
       a.run_id AS run_id,
       d.activation_id AS activation_id,
       a.node_id AS node_id,
       d.attempt_id AS attempt_id,
       d.payload_json AS payload_json,
       d.response_json AS response_json,
       d.created_at AS created_at,
       d.answered_at AS answered_at`

/**
 * Decode one stored JSON column.
 * @param text - stored JSON text.
 * @param column - column name for the diagnostic.
 * @returns the decoded value.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the column does not hold JSON.
 */
function decode(text: string, column: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new WorkflowProjectStoreError(
      'invalid-record',
      `workflow decision row carries unparseable JSON in column "${column}"`,
      { cause: error },
    )
  }
}

/**
 * Read one request payload from its column.
 * @param text - stored `payload_json` text.
 * @returns the validated payload.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the payload is
 * not an object with a string question and, when present, string options.
 */
function decisionPayload(text: string): DecisionPayload {
  const value = decode(text, 'payload_json')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow decision payload is not a JSON object')
  }
  const { question, options, detail } = value as {
    readonly question?: SQLOutputValue
    readonly options?: SQLOutputValue
    readonly detail?: SQLOutputValue
  }
  if (typeof question !== 'string') {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow decision payload lacks a string question')
  }
  if (options !== undefined && (!Array.isArray(options) || options.some(option => typeof option !== 'string'))) {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow decision payload carries options that are not strings')
  }
  return {
    question,
    ...options === undefined ? {} : { options: options as string[] },
    ...detail === undefined ? {} : { detail: detail as JsonValue },
  }
}

/**
 * Convert one joined row to its public record.
 * @param row - decision row in column declaration order.
 * @returns the decision record.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when a stored JSON column is corrupt.
 */
function decisionRecord(row: DecisionDbRow): DecisionRecord {
  return {
    requestId: row.request_id,
    runId: brandString<RunId>(row.run_id),
    activationId: brandString<ActivationId>(row.activation_id),
    nodeId: row.node_id,
    attemptId: row.attempt_id === null ? null : brandString<AttemptId>(row.attempt_id),
    payload: decisionPayload(row.payload_json),
    response: row.response_json === null ? undefined : decode(row.response_json, 'response_json') as JsonValue,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  }
}

/**
 * Record one decision request.
 * @param db - open project connection.
 * @param record - the request to record; its activation must already exist.
 * @param now - epoch milliseconds of the request.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function insertDecision(db: DatabaseSync, record: DecisionRequestInput, now: number): void {
  db.prepare('INSERT INTO decisions (request_id, activation_id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(record.requestId, record.activationId, record.attemptId, JSON.stringify(record.payload), now)
}

/**
 * Read one decision request.
 * @param db - open project connection.
 * @param requestId - request to read.
 * @returns the record, or `undefined` when this project holds no such request.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when a stored JSON column is corrupt.
 */
export function selectDecision(db: DatabaseSync, requestId: string): DecisionRecord | undefined {
  const row = db.prepare(
    `SELECT ${DECISION_COLUMNS} FROM decisions d JOIN activations a ON a.activation_id = d.activation_id WHERE d.request_id = ?`,
  ).get(requestId) as DecisionDbRow | undefined
  return row === undefined ? undefined : decisionRecord(row)
}

/**
 * Every unanswered decision request of one project, oldest first.
 * @param db - open project connection.
 * @returns the pending requests with the run and node they belong to.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when a stored JSON column is corrupt.
 */
export function selectPendingDecisions(db: DatabaseSync): DecisionRecord[] {
  const rows = db.prepare(
    `SELECT ${DECISION_COLUMNS}
       FROM decisions d JOIN activations a ON a.activation_id = d.activation_id
      WHERE d.response_json IS NULL
      ORDER BY d.created_at, d.rowid`,
  ).all()
  return rows.map(row => decisionRecord(row as DecisionDbRow))
}

/**
 * Record one answer, keeping the first answer authoritative.
 * @param db - open project connection.
 * @param requestId - request being answered.
 * @param response - the coordinator's answer, as lossless JSON.
 * @param answeredAt - epoch milliseconds of the answer.
 * @returns what the call did: this answer, the earlier answer, or that no such request exists.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when a stored JSON column is corrupt.
 */
export function answerDecision(
  db: DatabaseSync,
  requestId: string,
  response: JsonValue,
  answeredAt: number,
): DecisionAnswer {
  const { changes } = db.prepare(
    'UPDATE decisions SET response_json = ?, answered_at = ? WHERE request_id = ? AND response_json IS NULL',
  ).run(JSON.stringify(response), answeredAt, requestId)
  const record = selectDecision(db, requestId)
  if (record === undefined) return { kind: 'unknown' }
  return Number(changes) > 0 ? { kind: 'answered', decision: record } : { kind: 'already-answered', decision: record }
}

/**
 * The scheduler's row protocol over one project database: reads and writes of
 * runs, activations, attempts, artifacts, and the session outbox.
 *
 * Statements take an open `DatabaseSync` instead of a service so a caller can
 * commit one node's whole outcome — result, status transitions, artifacts, and
 * the staged outbox event — inside a single transaction through
 * `ctx.mwfProjectStore.transact`.
 *
 * @module @metaworkflow/workflow-scheduler/records
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { JsonValue } from '@metaworkflow/util-values'
import { WorkflowProjectStoreError } from '@metaworkflow/workflow-project-store'
import type { ActivationId, AttemptId, RunId, RunStatus } from '@metaworkflow/workflow-project-store'
import type {
  ActivationStatus,
  AttemptStatus,
  IncomingActivation,
  NodeFailure,
  RunParams,
} from './types.ts'

/** One run row in column declaration order. */
interface RunDbRow extends Record<string, SQLOutputValue> {
  readonly run_id: string
  readonly definition_revision: number
  readonly status: string
  readonly params_json: string
  readonly created_at: number
  readonly updated_at: number
  readonly reason: string | null
}

/** One activation row in column declaration order. */
interface ActivationDbRow extends Record<string, SQLOutputValue> {
  readonly activation_id: string
  readonly run_id: string
  readonly node_id: string
  readonly iteration: number
  readonly status: string
  readonly incoming_json: string
  readonly created_at: number
  readonly updated_at: number
}

/** One attempt row in column declaration order. */
interface AttemptDbRow extends Record<string, SQLOutputValue> {
  readonly attempt_id: string
  readonly activation_id: string
  readonly attempt_no: number
  readonly status: string
  readonly started_at: number
  readonly ended_at: number | null
  readonly error_json: string | null
  readonly result_json: string | null
}

/** One artifact row in column declaration order. */
interface ArtifactDbRow extends Record<string, SQLOutputValue> {
  readonly artifact_id: string
  readonly activation_id: string
  readonly name: string
  readonly version: number
  readonly rel_path: string
  readonly sha256: string | null
}

/** One run as the scheduler stores it. */
export interface RunRow {
  readonly runId: RunId
  readonly definitionRevision: number
  readonly status: RunStatus
  readonly params: RunParams
  readonly createdAt: number
  readonly updatedAt: number
  readonly reason: string | null
}

/** One activation as the scheduler stores it. */
export interface ActivationRow {
  readonly activationId: ActivationId
  readonly runId: RunId
  readonly nodeId: string
  readonly iteration: number
  readonly status: ActivationStatus
  readonly incoming: readonly IncomingActivation[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** One attempt as the scheduler stores it. */
export interface AttemptRow {
  readonly attemptId: AttemptId
  readonly activationId: ActivationId
  readonly attemptNo: number
  readonly status: AttemptStatus
  readonly startedAt: number
  readonly endedAt: number | null
  readonly error: NodeFailure | null
  /** The JSON value a successful attempt committed, parsed from its column. */
  readonly result: JsonValue | undefined
}

/** One artifact as the scheduler stores it. */
export interface ArtifactRow {
  readonly artifactId: string
  readonly activationId: ActivationId
  readonly name: string
  readonly version: number
  readonly path: string
  readonly sha256: string | null
}

/** Columns every run read selects, in declaration order. */
const RUN_COLUMNS = 'run_id, definition_revision, status, params_json, created_at, updated_at, reason'

/** Columns every activation read selects, in declaration order. */
const ACTIVATION_COLUMNS = 'activation_id, run_id, node_id, iteration, status, incoming_json, created_at, updated_at'

/** Columns every attempt read selects, in declaration order. */
const ATTEMPT_COLUMNS = 'attempt_id, activation_id, attempt_no, status, started_at, ended_at, error_json, result_json'

/** Columns every artifact read selects, in declaration order. */
const ARTIFACT_COLUMNS = 'artifact_id, activation_id, name, version, rel_path, sha256'

/**
 * Parse one JSON column the scheduler wrote.
 * @param text - stored JSON text.
 * @param column - column name for the diagnostic.
 * @returns the parsed value.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the column is not JSON.
 */
function parseColumn(text: string, column: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new WorkflowProjectStoreError(
      'invalid-record',
      `workflow scheduler row carries unparseable JSON in column "${column}"`,
      { cause: error },
    )
  }
}

/**
 * Read one run's parameters from their column.
 * @param text - stored `params_json` text.
 * @returns the parameters object.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the text is not a JSON object.
 */
function runParams(text: string): RunParams {
  const value = parseColumn(text, 'params_json')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler run parameters are not a JSON object')
  }
  return value as RunParams
}

/**
 * Read one activation's incoming activations from their column.
 * @param text - stored `incoming_json` text.
 * @returns the incoming activations in activation order.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the text is not a JSON array of references.
 */
function incomingActivations(text: string): readonly IncomingActivation[] {
  const value = parseColumn(text, 'incoming_json')
  if (!Array.isArray(value)) {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler activation incoming value is not a JSON array')
  }
  const incoming: IncomingActivation[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler incoming activation is not an object')
    }
    const { nodeId, iteration } = entry as { readonly nodeId?: SQLOutputValue; readonly iteration?: SQLOutputValue }
    if (typeof nodeId !== 'string' || typeof iteration !== 'number') {
      throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler incoming activation lacks a node id or iteration')
    }
    incoming.push({ nodeId, iteration })
  }
  return incoming
}

/**
 * Read one attempt's failure from its column.
 * @param text - stored `error_json` text, or `null`.
 * @returns the failure, or `null` when the attempt records none.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the text is not a failure object.
 */
function attemptFailure(text: string | null): NodeFailure | null {
  if (text === null) return null
  const value = parseColumn(text, 'error_json')
  if (typeof value !== 'object' || value === null) {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler attempt failure is not a JSON object')
  }
  const { code, message } = value as { readonly code?: SQLOutputValue; readonly message?: SQLOutputValue }
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw new WorkflowProjectStoreError('invalid-record', 'workflow scheduler attempt failure lacks a code or message')
  }
  return { code, message }
}

/**
 * Convert one run row to its record.
 * @param row - run row in column declaration order.
 * @returns the run record.
 */
function runRecord(row: RunDbRow): RunRow {
  return {
    runId: row.run_id as RunId,
    definitionRevision: row.definition_revision,
    status: row.status as RunStatus,
    params: runParams(row.params_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reason: row.reason,
  }
}

/**
 * Convert one activation row to its record.
 * @param row - activation row in column declaration order.
 * @returns the activation record.
 */
function activationRecord(row: ActivationDbRow): ActivationRow {
  return {
    activationId: row.activation_id as ActivationId,
    runId: row.run_id as RunId,
    nodeId: row.node_id,
    iteration: row.iteration,
    status: row.status as ActivationStatus,
    incoming: incomingActivations(row.incoming_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Convert one attempt row to its record.
 * @param row - attempt row in column declaration order.
 * @returns the attempt record.
 */
function attemptRecord(row: AttemptDbRow): AttemptRow {
  return {
    attemptId: row.attempt_id as AttemptId,
    activationId: row.activation_id as ActivationId,
    attemptNo: row.attempt_no,
    status: row.status as AttemptStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: attemptFailure(row.error_json),
    result: row.result_json === null ? undefined : parseColumn(row.result_json, 'result_json') as JsonValue,
  }
}

/**
 * Convert one artifact row to its record.
 * @param row - artifact row in column declaration order.
 * @returns the artifact record.
 */
function artifactRecord(row: ArtifactDbRow): ArtifactRow {
  return {
    artifactId: row.artifact_id,
    activationId: row.activation_id as ActivationId,
    name: row.name,
    version: row.version,
    path: row.rel_path,
    sha256: row.sha256,
  }
}

/**
 * Insert one run.
 * @param db - open project connection.
 * @param record - run to record.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function insertRun(db: DatabaseSync, record: RunRow): void {
  db.prepare(`INSERT INTO runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.runId,
      record.definitionRevision,
      record.status,
      JSON.stringify(record.params),
      record.createdAt,
      record.updatedAt,
      record.reason,
    )
}

/**
 * Read one run.
 * @param db - open project connection.
 * @param runId - run to read.
 * @returns the run, or `undefined` when the project holds no such run.
 */
export function selectRun(db: DatabaseSync, runId: RunId): RunRow | undefined {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as RunDbRow | undefined
  return row === undefined ? undefined : runRecord(row)
}

/**
 * Every run of the project.
 * @param db - open project connection.
 * @returns the runs in creation order.
 */
export function selectRuns(db: DatabaseSync): RunRow[] {
  const rows = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at, run_id`).all()
  return rows.map(row => runRecord(row as RunDbRow))
}

/**
 * Record one run status transition.
 * @param db - open project connection.
 * @param runId - run to update.
 * @param status - status the run now carries.
 * @param reason - why it changed, or `null` to record none.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing.
 */
export function updateRunStatus(
  db: DatabaseSync,
  runId: RunId,
  status: RunStatus,
  reason: string | null,
  updatedAt: number,
): void {
  db.prepare('UPDATE runs SET status = ?, reason = ?, updated_at = ? WHERE run_id = ?')
    .run(status, reason, updatedAt, runId)
}

/**
 * Start one pending run: mark it running if it has not started yet.
 *
 * The guard is part of the statement, so a run that a concurrent pause parked
 * between the caller's read and this write keeps the status it was given.
 * @param db - open project connection.
 * @param runId - run to start.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing.
 */
export function startRunIfPending(db: DatabaseSync, runId: RunId, updatedAt: number): void {
  db.prepare("UPDATE runs SET status = 'running', reason = NULL, updated_at = ? WHERE run_id = ? AND status = 'pending'")
    .run(updatedAt, runId)
}

/**
 * Insert one activation.
 * @param db - open project connection.
 * @param record - activation to record.
 * @returns nothing.
 */
export function insertActivation(db: DatabaseSync, record: ActivationRow): void {
  db.prepare(`INSERT INTO activations (${ACTIVATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.activationId,
      record.runId,
      record.nodeId,
      record.iteration,
      record.status,
      JSON.stringify(record.incoming),
      record.createdAt,
      record.updatedAt,
    )
}

/**
 * Read one activation.
 * @param db - open project connection.
 * @param activationId - activation to read.
 * @returns the activation, or `undefined` when the project holds no such activation.
 */
export function selectActivation(db: DatabaseSync, activationId: ActivationId): ActivationRow | undefined {
  const row = db.prepare(`SELECT ${ACTIVATION_COLUMNS} FROM activations WHERE activation_id = ?`)
    .get(activationId) as ActivationDbRow | undefined
  return row === undefined ? undefined : activationRecord(row)
}

/**
 * Every activation of one run.
 * @param db - open project connection.
 * @param runId - run whose activations are read.
 * @returns the activations in creation order.
 */
export function selectRunActivations(db: DatabaseSync, runId: RunId): ActivationRow[] {
  // rowid keeps rows committed by one transaction in insertion order; the
  // creation stamp cannot, because a whole routing batch shares one millisecond.
  const rows = db.prepare(`SELECT ${ACTIVATION_COLUMNS} FROM activations WHERE run_id = ? ORDER BY created_at, rowid`)
    .all(runId)
  return rows.map(row => activationRecord(row as ActivationDbRow))
}

/**
 * Record one activation status transition.
 * @param db - open project connection.
 * @param activationId - activation to update.
 * @param status - status the activation now carries.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing.
 */
export function updateActivationStatus(
  db: DatabaseSync,
  activationId: ActivationId,
  status: ActivationStatus,
  updatedAt: number,
): void {
  db.prepare('UPDATE activations SET status = ?, updated_at = ? WHERE activation_id = ?')
    .run(status, updatedAt, activationId)
}

/**
 * Replace one activation's incoming set.
 * @param db - open project connection.
 * @param activationId - activation to update.
 * @param incoming - incoming activations the join expects.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing.
 */
export function updateActivationIncoming(
  db: DatabaseSync,
  activationId: ActivationId,
  incoming: readonly IncomingActivation[],
  updatedAt: number,
): void {
  db.prepare('UPDATE activations SET incoming_json = ?, updated_at = ? WHERE activation_id = ?')
    .run(JSON.stringify(incoming), updatedAt, activationId)
}

/**
 * The fields one attempt row starts with; its result and failure are written later.
 */
export interface AttemptStart {
  readonly attemptId: AttemptId
  readonly activationId: ActivationId
  readonly attemptNo: number
  readonly status: AttemptStatus
  readonly startedAt: number
}

/**
 * Insert one attempt.
 * @param db - open project connection.
 * @param record - attempt to record; its result and failure start empty.
 * @returns nothing.
 */
export function insertAttempt(db: DatabaseSync, record: AttemptStart): void {
  db.prepare('INSERT INTO attempts (attempt_id, activation_id, attempt_no, status, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(record.attemptId, record.activationId, record.attemptNo, record.status, record.startedAt)
}

/**
 * Read one attempt.
 * @param db - open project connection.
 * @param attemptId - attempt to read.
 * @returns the attempt, or `undefined` when the project holds no such attempt.
 */
export function selectAttempt(db: DatabaseSync, attemptId: AttemptId): AttemptRow | undefined {
  const row = db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE attempt_id = ?`)
    .get(attemptId) as AttemptDbRow | undefined
  return row === undefined ? undefined : attemptRecord(row)
}

/**
 * Every attempt of one run, oldest first.
 * @param db - open project connection.
 * @param runId - run whose attempts are read.
 * @returns the attempts in activation and attempt order.
 */
export function selectRunAttempts(db: DatabaseSync, runId: RunId): AttemptRow[] {
  const rows = db.prepare(
    `SELECT ${ATTEMPT_COLUMNS.split(', ').map(column => `a.${column}`).join(', ')}
       FROM attempts a JOIN activations c ON c.activation_id = a.activation_id
      WHERE c.run_id = ?
      ORDER BY a.started_at, a.rowid`,
  ).all(runId)
  return rows.map(row => attemptRecord(row as AttemptDbRow))
}

/**
 * Every attempt of one activation, oldest first.
 * @param db - open project connection.
 * @param activationId - activation whose attempts are read.
 * @returns the attempts in attempt order.
 */
export function selectActivationAttempts(db: DatabaseSync, activationId: ActivationId): AttemptRow[] {
  const rows = db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE activation_id = ? ORDER BY attempt_no`)
    .all(activationId)
  return rows.map(row => attemptRecord(row as AttemptDbRow))
}

/**
 * Every artifact one run published.
 * @param db - open project connection.
 * @param runId - run whose artifacts are read.
 * @returns the artifacts in publication order.
 */
export function selectRunArtifacts(db: DatabaseSync, runId: RunId): ArtifactRow[] {
  const rows = db.prepare(
    `SELECT ${ARTIFACT_COLUMNS.split(', ').map(column => `t.${column}`).join(', ')}
       FROM artifacts t JOIN activations c ON c.activation_id = t.activation_id
      WHERE c.run_id = ?
      ORDER BY c.created_at, t.rowid`,
  ).all(runId)
  return rows.map(row => artifactRecord(row as ArtifactDbRow))
}

/**
 * Every attempt still marked running in this project.
 * @param db - open project connection.
 * @returns the running attempts with their activation and run, in row order.
 */
export function selectRunningAttempts(
  db: DatabaseSync,
): Array<{ readonly attemptId: AttemptId; readonly activationId: ActivationId; readonly runId: RunId }> {
  const rows = db.prepare(
    `SELECT a.attempt_id AS attempt_id, a.activation_id AS activation_id, c.run_id AS run_id
       FROM attempts a JOIN activations c ON c.activation_id = a.activation_id
      WHERE a.status = 'running'
      ORDER BY a.started_at, a.attempt_id`,
  ).all()
  return rows.map(row => ({
    attemptId: row.attempt_id as AttemptId,
    activationId: row.activation_id as ActivationId,
    runId: row.run_id as RunId,
  }))
}

/**
 * Record one attempt's terminal outcome.
 * @param db - open project connection.
 * @param attemptId - attempt to update.
 * @param status - status the attempt now carries.
 * @param endedAt - epoch milliseconds at which it settled.
 * @param error - failure the executor reported, or `null`.
 * @param result - JSON value a successful attempt committed, or `undefined`.
 * @returns nothing.
 */
export function updateAttemptOutcome(
  db: DatabaseSync,
  attemptId: AttemptId,
  status: AttemptStatus,
  endedAt: number,
  error: NodeFailure | null,
  result: JsonValue | undefined,
): void {
  db.prepare('UPDATE attempts SET status = ?, ended_at = ?, error_json = ?, result_json = ? WHERE attempt_id = ?')
    .run(
      status,
      endedAt,
      error === null ? null : JSON.stringify(error),
      result === undefined ? null : JSON.stringify(result),
      attemptId,
    )
}

/**
 * Publish one artifact produced by an activation.
 * @param db - open project connection.
 * @param record - artifact to record.
 * @returns nothing.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` when the same name
 * was already published at the same version by this activation.
 */
export function insertArtifact(db: DatabaseSync, record: ArtifactRow & { readonly attemptId: AttemptId }): void {
  db.prepare(
    'INSERT INTO artifacts (artifact_id, activation_id, attempt_id, name, version, rel_path, sha256, immutable) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(
    record.artifactId,
    record.activationId,
    record.attemptId,
    record.name,
    record.version,
    record.path,
    record.sha256,
  )
}

/**
 * The next version number of one artifact name within one activation.
 * @param db - open project connection.
 * @param activationId - activation publishing the artifact.
 * @param name - artifact name.
 * @returns one more than the highest version this activation published, or `1`.
 */
export function nextArtifactVersion(db: DatabaseSync, activationId: ActivationId, name: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM artifacts WHERE activation_id = ? AND name = ?')
    .get(activationId, name) as { version: number }
  return row.version + 1
}

/**
 * Stage one session-outbox event in the caller's transaction.
 *
 * `(attemptId, eventSeq)` is the idempotency key, so a repeated commit keeps the
 * row already stored instead of writing a duplicate.
 * @param db - open project connection.
 * @param attemptId - attempt the event reports.
 * @param eventSeq - per-attempt event sequence.
 * @param payload - event payload text.
 * @returns nothing.
 */
export function insertOutboxEvent(db: DatabaseSync, attemptId: AttemptId, eventSeq: number, payload: string): void {
  db.prepare('INSERT INTO session_outbox (attempt_id, event_seq, payload) VALUES (?, ?, ?) ON CONFLICT (attempt_id, event_seq) DO NOTHING')
    .run(attemptId, eventSeq, payload)
}

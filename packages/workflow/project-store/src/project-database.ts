/**
 * One project database, holding the definition revisions and the run,
 * activation, attempt, artifact, decision, and session-outbox records of
 * exactly one project.
 *
 * The file lives in the store's own project directory, never in the project's
 * working directory, so a working directory holds only the user's code and
 * artifacts and can be moved or deleted without the database.
 *
 * The v2 layout adds the three columns the scheduler needs to make a run
 * resumable: the run's parameters, the incoming activations one activation
 * joins, and the committed result of one attempt. A v1 library gains them
 * through the declared upgrade step.
 *
 * @module @metaworkflow/workflow-project-store/project-database
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { brandString } from '@metaworkflow/brand'
import { WorkflowProjectStoreError } from './errors.ts'
import { openWorkflowDatabase, type WorkflowDatabaseOpenOptions, type WorkflowDatabaseUpgrade } from './open.ts'
import type { AttemptId, DefinitionRecord, OutboxRecord, RunId, RunRecord, RunStatus } from './types.ts'

/**
 * Project layout version in `PRAGMA user_version`. A database stamped with an
 * older version is upgraded through the declared steps in
 * {@link PROJECT_UPGRADES}; a version no step leads from is refused.
 */
export const WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION = 2

/**
 * Project `PRAGMA application_id` identity (`MWPJ`). It differs from the
 * registry identity, so neither file can be opened as the other.
 */
export const WORKFLOW_PROJECT_DATABASE_APPLICATION_ID = 0x4d57504a

/** Stable `schema_meta` row naming this database's role and version. */
const PROJECT_FORMAT = 'workflow-project/2'

/**
 * File name of one project database inside the store's own project directory.
 * A library written before the database moved out of the working directory
 * holds the same file name inside that directory.
 */
export const PROJECT_DATABASE_FILE_NAME = 'project.db'

/** Run statuses the store accepts from the medium. */
const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>(['pending', 'running', 'paused', 'succeeded', 'failed', 'canceled'])

/**
 * Layout upgrades of the project database, applied only when an existing
 * library is older than {@link WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION}.
 */
const PROJECT_UPGRADES: readonly WorkflowDatabaseUpgrade[] = [
  { from: 1, apply: addSchedulerColumns },
]

/** One row as `node:sqlite` hands it back: column values keyed by column name. */
type SqlRow = Record<string, SQLOutputValue>

/** One definition row in column declaration order. */
interface DefinitionRow extends SqlRow {
  readonly revision: number
  readonly document: string
  readonly created_at: number
}

/** One run row in column declaration order. */
interface RunRow extends SqlRow {
  readonly run_id: string
  readonly definition_revision: number
  readonly status: string
  readonly created_at: number
  readonly updated_at: number
  readonly reason: string | null
}

/** One outbox row in column declaration order. */
interface OutboxRow extends SqlRow {
  readonly attempt_id: string
  readonly event_seq: number
  readonly payload: string
  readonly acked_at: number | null
}

/** Columns every run read selects, in declaration order. */
const RUN_COLUMNS = 'run_id, definition_revision, status, created_at, updated_at, reason'

/** Columns every outbox read selects, in declaration order. */
const OUTBOX_COLUMNS = 'attempt_id, event_seq, payload, acked_at'

/**
 * Open one project database, creating and materializing it when absent.
 * @param path - project database path in the store's own project directory, or the
 * pre-migration location inside a working directory.
 * @param options - timing knobs of the open protocol.
 * @returns the open project connection.
 */
export async function openProjectDatabase(
  path: string,
  options?: WorkflowDatabaseOpenOptions,
): Promise<DatabaseSync> {
  return openWorkflowDatabase({
    ...options,
    path,
    applicationId: WORKFLOW_PROJECT_DATABASE_APPLICATION_ID,
    schemaVersion: WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION,
    upgrades: PROJECT_UPGRADES,
    materialize: materializeProjectSchema,
  })
}

/**
 * Upgrade a v1 project library: add the run parameters, the incoming
 * activations of each activation, and the committed result of each attempt,
 * then refresh the format marker.
 *
 * Every added column is absent from a v1 row, so the empty defaults a v1
 * library receives mean "no parameters", "no incoming activation", and "no
 * result" — the same values the scheduler writes for a fresh run.
 * @param db - v1 project connection holding the write lock of its upgrade batch.
 * @returns nothing.
 */
function addSchedulerColumns(db: DatabaseSync): void {
  db.exec("ALTER TABLE runs ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}'")
  db.exec("ALTER TABLE activations ADD COLUMN incoming_json TEXT NOT NULL DEFAULT '[]'")
  db.exec('ALTER TABLE attempts ADD COLUMN result_json TEXT')
  db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(PROJECT_FORMAT, 'format')
}

/**
 * Create every project table and index that does not exist yet.
 *
 * `nodes` and `edges` carry one row per definition revision, cascading with it.
 * Runs reference the revision they started from; activations, attempts,
 * artifacts, and decisions cascade from their run or activation. The session
 * outbox keys on the attempt it delivers for and enforces that the attempt
 * exists.
 * Runs carry the parameters the run started with; an activation carries the
 * incoming activations it joins and an attempt carries the result it
 * committed, so a reopened run rebuilds its inputs instead of restarting work.
 * @param db - connection whose identity and version are already accepted.
 * @returns nothing.
 */
function materializeProjectSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS definitions (
      revision   INTEGER PRIMARY KEY,
      document   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id     TEXT NOT NULL,
      revision    INTEGER NOT NULL REFERENCES definitions(revision) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      config_json TEXT NOT NULL,
      PRIMARY KEY (node_id, revision)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      edge_id        TEXT NOT NULL,
      revision       INTEGER NOT NULL REFERENCES definitions(revision) ON DELETE CASCADE,
      from_node      TEXT NOT NULL,
      to_node        TEXT NOT NULL,
      condition_json TEXT,
      PRIMARY KEY (edge_id, revision)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id              TEXT PRIMARY KEY,
      definition_revision INTEGER NOT NULL REFERENCES definitions(revision),
      status              TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      reason              TEXT,
      params_json         TEXT NOT NULL DEFAULT '{}'
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS activations (
      activation_id TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL,
      iteration     INTEGER NOT NULL,
      status        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      incoming_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (run_id, node_id, iteration)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
      attempt_id    TEXT PRIMARY KEY,
      activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE CASCADE,
      attempt_no    INTEGER NOT NULL,
      status        TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      error_json    TEXT,
      result_json   TEXT,
      UNIQUE (activation_id, attempt_no)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id   TEXT PRIMARY KEY,
      activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE CASCADE,
      attempt_id    TEXT REFERENCES attempts(attempt_id),
      name          TEXT NOT NULL,
      version       INTEGER NOT NULL,
      rel_path      TEXT NOT NULL,
      sha256        TEXT,
      immutable     INTEGER NOT NULL CHECK (immutable IN (0, 1)),
      superseded_by TEXT,
      UNIQUE (activation_id, name, version)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      request_id    TEXT PRIMARY KEY,
      activation_id TEXT NOT NULL REFERENCES activations(activation_id) ON DELETE CASCADE,
      attempt_id    TEXT REFERENCES attempts(attempt_id),
      payload_json  TEXT NOT NULL,
      response_json TEXT,
      created_at    INTEGER NOT NULL,
      answered_at   INTEGER
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_outbox (
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
      event_seq  INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      acked_at   INTEGER,
      PRIMARY KEY (attempt_id, event_seq)
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS nodes_by_revision ON nodes(revision)')
  db.exec('CREATE INDEX IF NOT EXISTS edges_by_revision ON edges(revision)')
  db.exec('CREATE INDEX IF NOT EXISTS runs_by_created ON runs(created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS activations_by_run ON activations(run_id, node_id)')
  db.exec('CREATE INDEX IF NOT EXISTS attempts_by_activation ON attempts(activation_id)')
  db.exec('CREATE INDEX IF NOT EXISTS artifacts_by_activation ON artifacts(activation_id)')
  db.exec('CREATE INDEX IF NOT EXISTS decisions_by_activation ON decisions(activation_id)')
  db.exec('CREATE INDEX IF NOT EXISTS session_outbox_by_ack ON session_outbox(acked_at, attempt_id)')
  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('format', PROJECT_FORMAT)
}

/**
 * Read one definition revision.
 * @param db - open project connection.
 * @param revision - definition revision to read.
 * @returns the stored revision, or `undefined` when the project has no such revision.
 */
export function selectDefinition(db: DatabaseSync, revision: number): DefinitionRecord | undefined {
  const row = db.prepare('SELECT revision, document, created_at FROM definitions WHERE revision = ?')
    .get(revision) as DefinitionRow | undefined
  return row === undefined ? undefined : definitionRecord(row)
}

/**
 * Read the newest definition revision.
 * @param db - open project connection.
 * @returns the newest revision, or `undefined` when the project has no definition yet.
 */
export function selectLatestDefinition(db: DatabaseSync): DefinitionRecord | undefined {
  const row = db.prepare('SELECT revision, document, created_at FROM definitions ORDER BY revision DESC LIMIT 1')
    .get() as DefinitionRow | undefined
  return row === undefined ? undefined : definitionRecord(row)
}

/**
 * The revision number the next definition write must use.
 * @param db - open project connection.
 * @returns the current maximum revision plus one, or 1 for the first write.
 */
export function nextDefinitionRevision(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM definitions').get() as { revision: number }
  return row.revision + 1
}

/**
 * Store one definition revision.
 * @param db - open project connection.
 * @param record - revision, document text, and creation time to store.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function insertDefinition(db: DatabaseSync, record: DefinitionRecord): void {
  db.prepare('INSERT INTO definitions (revision, document, created_at) VALUES (?, ?, ?)')
    .run(record.revision, record.document, record.createdAt)
}

/**
 * Every run of one project, newest first.
 * @param db - open project connection.
 * @returns the run records, with statuses validated against the declared vocabulary.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when a stored status is unknown.
 */
export function selectRuns(db: DatabaseSync): RunRecord[] {
  const rows = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY created_at DESC, run_id`).all()
  return rows.map(row => runRecord(row as RunRow))
}

/**
 * Read one outbox row.
 * @param db - open project connection.
 * @param attemptId - attempt the event belongs to.
 * @param eventSeq - per-attempt event sequence.
 * @returns the stored row, or `undefined` when it was never appended.
 */
function selectOutboxRow(db: DatabaseSync, attemptId: AttemptId, eventSeq: number): OutboxRecord | undefined {
  const row = db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM session_outbox WHERE attempt_id = ? AND event_seq = ?`)
    .get(attemptId, eventSeq) as OutboxRow | undefined
  return row === undefined ? undefined : outboxRecord(row)
}

/**
 * Every outbox row of one attempt in event order.
 * @param db - open project connection.
 * @param attemptId - attempt whose events are read.
 * @returns the stored rows, acknowledged or not.
 */
export function selectOutboxRows(db: DatabaseSync, attemptId: AttemptId): OutboxRecord[] {
  const rows = db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM session_outbox WHERE attempt_id = ? ORDER BY event_seq`)
    .all(attemptId)
  return rows.map(row => outboxRecord(row as OutboxRow))
}

/**
 * Stage one outbox event, keeping an event that was already staged.
 * @param db - open project connection.
 * @param attemptId - attempt the event belongs to.
 * @param eventSeq - per-attempt event sequence; `(attemptId, eventSeq)` is the idempotency key.
 * @param payload - event payload text.
 * @returns the event as stored: the earlier row when the key already existed, otherwise the new unacknowledged row.
 * @throws {@link WorkflowProjectStoreError} `unknown-attempt` when the project has no such attempt.
 */
export function stageOutboxRow(
  db: DatabaseSync,
  attemptId: AttemptId,
  eventSeq: number,
  payload: string,
): OutboxRecord {
  const existing = selectOutboxRow(db, attemptId, eventSeq)
  if (existing !== undefined) return existing
  // The row references its attempt, so an absent attempt fails typed here
  // rather than as a raw foreign-key violation from the insert below.
  const attempt = db.prepare('SELECT 1 AS present FROM attempts WHERE attempt_id = ?').get(attemptId)
  if (attempt === undefined) {
    throw new WorkflowProjectStoreError('unknown-attempt', `attempt '${attemptId}' is not recorded in this project database`)
  }
  db.prepare('INSERT INTO session_outbox (attempt_id, event_seq, payload) VALUES (?, ?, ?)')
    .run(attemptId, eventSeq, payload)
  return { attemptId, eventSeq, payload, ackedAt: null }
}

/**
 * Acknowledge one staged outbox event.
 * @param db - open project connection.
 * @param attemptId - attempt the event belongs to.
 * @param eventSeq - per-attempt event sequence.
 * @param ackedAt - epoch milliseconds of the acknowledgement.
 * @returns `true` when this call acknowledged the row, `false` when it was
 * absent or already acknowledged.
 */
export function ackOutboxRow(
  db: DatabaseSync,
  attemptId: AttemptId,
  eventSeq: number,
  ackedAt: number,
): boolean {
  const { changes } = db.prepare('UPDATE session_outbox SET acked_at = ? WHERE attempt_id = ? AND event_seq = ? AND acked_at IS NULL')
    .run(ackedAt, attemptId, eventSeq)
  return Number(changes) > 0
}

/**
 * Convert one definition row to its public record.
 * @param row - definition row in column declaration order.
 * @returns the definition record.
 */
function definitionRecord(row: DefinitionRow): DefinitionRecord {
  return { revision: row.revision, document: row.document, createdAt: row.created_at }
}

/**
 * Convert one run row to its public record, validating the stored status.
 * @param row - run row in column declaration order.
 * @returns the run record.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the status is outside the vocabulary.
 */
function runRecord(row: RunRow): RunRecord {
  if (!RUN_STATUSES.has(row.status)) {
    throw new WorkflowProjectStoreError(
      'invalid-record',
      `run '${row.run_id}' carries unknown status '${row.status}'`,
    )
  }
  return {
    runId: brandString<RunId>(row.run_id),
    definitionRevision: row.definition_revision,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reason: row.reason,
  }
}

/**
 * Convert one outbox row to its public record.
 * @param row - outbox row in column declaration order.
 * @returns the outbox record.
 */
function outboxRecord(row: OutboxRow): OutboxRecord {
  return {
    attemptId: brandString<AttemptId>(row.attempt_id),
    eventSeq: row.event_seq,
    payload: row.payload,
    ackedAt: row.acked_at,
  }
}

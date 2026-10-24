/**
 * Decision requests as the store's consumers see them: one durable question per
 * asking attempt, a pending list that names the run and node it belongs to, the
 * first answer winning, a repeated answer reporting the recorded one, an unknown
 * id writing nothing, and the corruption refusals of a durable JSON column.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@metaworkflow/brand'
import Store, {
  WorkflowProjectStoreError,
  type ActivationId,
  type AttemptId,
  type ProjectId,
  type RunId,
} from '../src/index.ts'

const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One project with the run, activation, and attempt a decision references. */
interface Fixture {
  readonly store: Store
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly activationId: ActivationId
  readonly attemptId: AttemptId
}

/**
 * Mount one project over a fresh temporary home and record the rows a decision
 * request references.
 * @returns the mounted fixture.
 */
async function fixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-decisions-'))
  directories.push(home)
  const store = new Store(new Context(), { mwfHome: home })
  stores.push(store)
  const project = await store.createProject({ title: 'decisions' })
  const runId = brandString<RunId>('run-1')
  const activationId = brandString<ActivationId>('activation-1')
  const attemptId = brandString<AttemptId>('attempt-1')
  await store.transact(project.id, (db) => {
    db.prepare('INSERT INTO definitions (revision, document, created_at) VALUES (1, ?, 0)').run('{"version":1,"nodes":[],"edges":[]}')
    db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at, reason) VALUES (?, 1, ?, 0, 0, NULL)')
      .run(runId, 'running')
    db.prepare('INSERT INTO activations (activation_id, run_id, node_id, iteration, status, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, 0)')
      .run(activationId, runId, 'ask', 'waiting')
    db.prepare('INSERT INTO attempts (attempt_id, activation_id, attempt_no, status, started_at) VALUES (?, ?, 1, ?, 0)')
      .run(attemptId, activationId, 'waiting')
  })
  return { store, projectId: project.id, runId, activationId, attemptId }
}

/**
 * Record one request through the store.
 * @param f - the fixture whose activation asks.
 * @param requestId - request identity to record.
 * @param payload - the question and its optional context.
 * @returns nothing.
 */
async function ask(
  f: Fixture,
  requestId: string,
  payload: { question: string; options?: readonly string[]; detail?: string },
): Promise<void> {
  await f.store.requestDecision(f.projectId, {
    requestId,
    activationId: f.activationId,
    attemptId: f.attemptId,
    payload,
  })
}

describe('decision requests', () => {
  it('records a pending request that names its run and node', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?', options: ['yes', 'no'], detail: 'why now' })
    const pending = await f.store.listPendingDecisions(f.projectId)
    expect(pending).toHaveLength(1)
    const [record] = pending
    expect(record?.requestId).toBe('decision-1')
    expect(record?.runId).toBe(f.runId)
    expect(record?.activationId).toBe(f.activationId)
    expect(record?.attemptId).toBe(f.attemptId)
    expect(record?.nodeId).toBe('ask')
    expect(record?.payload).toEqual({ question: 'Ship it?', options: ['yes', 'no'], detail: 'why now' })
    expect(record?.response).toBeUndefined()
    expect(record?.answeredAt).toBeNull()
    expect(record?.createdAt).toBeGreaterThan(0)
  })

  it('records a request that carries no options and no detail', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Which way?' })
    const [record] = await f.store.listPendingDecisions(f.projectId)
    expect(record?.payload).toEqual({ question: 'Which way?' })
  })

  it('answers once and drops the request from the pending list', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    const answer = await f.store.answerDecision(f.projectId, 'decision-1', { approved: true })
    expect(answer.kind).toBe('answered')
    expect(answer.kind === 'unknown' ? undefined : answer.decision.response).toEqual({ approved: true })
    expect(answer.kind === 'unknown' ? undefined : answer.decision.answeredAt).not.toBeNull()
    expect(await f.store.listPendingDecisions(f.projectId)).toEqual([])
  })

  it('keeps the first answer when a second arrives', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await f.store.answerDecision(f.projectId, 'decision-1', 'first')
    const repeated = await f.store.answerDecision(f.projectId, 'decision-1', 'second')
    expect(repeated.kind).toBe('already-answered')
    expect(repeated.kind === 'unknown' ? undefined : repeated.decision.response).toBe('first')
  })

  it('reports an unknown request id without writing a row', async () => {
    const f = await fixture()
    expect(await f.store.answerDecision(f.projectId, 'never-asked', 'answer')).toEqual({ kind: 'unknown' })
    expect(await f.store.listPendingDecisions(f.projectId)).toEqual([])
  })

  it('lists pending requests oldest first across activations', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'first' })
    await ask(f, 'decision-2', { question: 'second' })
    expect((await f.store.listPendingDecisions(f.projectId)).map(record => record.requestId))
      .toEqual(['decision-1', 'decision-2'])
  })
})

describe('decision record corruption', () => {
  /**
   * Replace one decision row's payload with arbitrary text.
   * @param f - the fixture holding the row.
   * @param payload - text to store.
   * @returns nothing.
   */
  async function writePayload(f: Fixture, payload: string): Promise<void> {
    await f.store.transact(f.projectId, (db) => {
      db.prepare('UPDATE decisions SET payload_json = ? WHERE request_id = ?').run(payload, 'decision-1')
    })
  }

  it('refuses a payload that is not JSON at all', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await writePayload(f, 'not json')
    await expect(f.store.listPendingDecisions(f.projectId)).rejects.toThrow(WorkflowProjectStoreError)
  })

  it('refuses a payload that is not a JSON object', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await writePayload(f, '["question"]')
    await expect(f.store.listPendingDecisions(f.projectId)).rejects.toThrow('payload is not a JSON object')
  })

  it('refuses a payload without a string question', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await writePayload(f, '{"question": 4}')
    await expect(f.store.listPendingDecisions(f.projectId)).rejects.toThrow('lacks a string question')
  })

  it('refuses options that are not strings', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await writePayload(f, '{"question":"Ship it?","options":[1]}')
    await expect(f.store.listPendingDecisions(f.projectId)).rejects.toThrow('options that are not strings')
  })

  it('refuses a response column that is not JSON', async () => {
    const f = await fixture()
    await ask(f, 'decision-1', { question: 'Ship it?' })
    await f.store.transact(f.projectId, (db) => {
      db.prepare('UPDATE decisions SET response_json = ?, answered_at = 1 WHERE request_id = ?').run('{', 'decision-1')
    })
    await expect(f.store.answerDecision(f.projectId, 'decision-1', 'again')).rejects.toThrow(WorkflowProjectStoreError)
  })

  it('reports a request whose attempt is unknown to the database as a null attempt', async () => {
    const f = await fixture()
    await f.store.transact(f.projectId, (db) => {
      db.prepare('INSERT INTO decisions (request_id, activation_id, attempt_id, payload_json, created_at) VALUES (?, ?, NULL, ?, 0)')
        .run('decision-legacy', f.activationId, '{"question":"legacy"}')
    })
    const [record] = await f.store.listPendingDecisions(f.projectId)
    expect(record?.attemptId).toBeNull()
  })
})

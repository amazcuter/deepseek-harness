/**
 * Commit atomicity: an attempt's result, its status transitions, and its staged
 * outbox event commit together, so a failing write leaves no half-applied
 * outcome and a late result commits nothing at all.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { openProjectDatabase } from '@metaworkflow/workflow-project-store'
import { FakeExecutor, deferred, define, definition, edge, harness, pythonNode, startRun } from './support/harness.ts'
import type { Harness } from './support/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses.splice(0)) await mounted.close()
})

async function mounted(): Promise<Harness> {
  const created = await harness()
  harnesses.push(created)
  return created
}

/**
 * Run one statement against the project database through a second connection,
 * the way a corrupt medium or an injected failure would.
 */
async function withSecondConnection(h: Harness, statement: (db: Awaited<ReturnType<typeof openProjectDatabase>>) => void): Promise<void> {
  const db = await openProjectDatabase(h.project.dbPath)
  try {
    statement(db)
  } finally {
    db.close()
  }
}

describe('outcome transactions', () => {
  it('rolls the whole outcome back when the outbox write fails', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { ok: true } })))
    const runId = await startRun(h, revision)
    await withSecondConnection(h, (db) => {
      db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON session_outbox BEGIN SELECT RAISE(ABORT, 'outbox write failed'); END")
    })

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).rejects.toThrow(/outbox write failed/u)

    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => activation.status)).toEqual(['running'])
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['running'])
    await expect(h.store.listOutbox(h.projectId, attempts[0]?.attemptId ?? 'none' as never)).resolves.toEqual([])

    await withSecondConnection(h, (db) => {
      db.exec('DROP TRIGGER fail_outbox')
    })
    await h.scheduler.reconcile({ projectId: h.projectId })
    await h.scheduler.resume({ projectId: h.projectId, runId })
    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const recovered = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(recovered.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'interrupted'], [2, 'succeeded']])
  })

  it('stages one outbox event per committed attempt and keeps it idempotent', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { done: true } })))
    const runId = await startRun(h, revision)
    await h.scheduler.tick({ projectId: h.projectId, runId })

    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts).toHaveLength(2)
    for (const attempt of attempts) {
      const events = await h.store.listOutbox(h.projectId, attempt.attemptId)
      expect(events.map(event => event.eventSeq)).toEqual([0])
      expect(JSON.parse(events[0]?.payload ?? '{}')).toMatchObject({
        type: 'scheduler/attempt-result',
        runId,
        status: 'succeeded',
        value: { done: true },
      })
    }
    // Repeating the same attempt outcome is a no-op, not a second event.
    await h.store.appendOutbox(h.projectId, attempts[0]?.attemptId ?? 'none' as never, 0, '{"replayed":true}')
    const again = await h.store.listOutbox(h.projectId, attempts[0]?.attemptId ?? 'none' as never)
    expect(again).toHaveLength(1)
    expect(JSON.parse(again[0]?.payload ?? '{}')).toMatchObject({ type: 'scheduler/attempt-result' })
  })
})

describe('stale outcomes', () => {
  it('refuses a result committed after the run moved to another revision', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    const python = new FakeExecutor('python', () => gate.promise)
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    for (let attempt = 0; attempt < 2000 && python.calls.length < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const nextRevision = await h.store.writeDefinition(h.projectId, JSON.stringify({ version: 1, nodes: [], edges: [] }))
    await h.store.transact(h.projectId, (db) => {
      db.prepare('UPDATE runs SET definition_revision = ? WHERE run_id = ?').run(nextRevision, runId)
    })
    gate.resolve({ status: 'succeeded', value: null })
    const stale = await ticking
    expect(stale.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/stale-result')
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['running'])
    await expect(h.store.transact(h.projectId, db => db.prepare('SELECT COUNT(*) AS events FROM session_outbox').get()))
      .resolves.toEqual({ events: 0 })
  })
})

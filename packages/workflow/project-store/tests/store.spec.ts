import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@metaworkflow/brand'
import Store, {
  WorkflowProjectStoreError,
  WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION,
  WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID,
  WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION,
  type AttemptId,
  type ProjectId,
  type ProjectRecord,
} from '../src/index.ts'

const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-project-store-'))
  directories.push(home)
  return home
}

interface Harness {
  readonly home: string
  readonly store: Store
}

async function openStore(): Promise<Harness> {
  const home = await temporaryHome()
  const store = new Store(new Context(), { mwfHome: home })
  stores.push(store)
  return { home, store }
}

function ghostId(): ProjectId {
  return brandString<ProjectId>('0f0f0f0f-1111-4222-8333-444444444444')
}

/** Where a library written before the database moved keeps one project's database. */
function legacyDatabase(record: ProjectRecord): string {
  return join(record.path, 'project.db')
}

/** How a v1 fixture treats the canonical database file. */
type LegacyDatabase = 'move' | 'copy' | 'missing'

/**
 * Reach back into one project's library state, the way a build that kept the
 * database inside the working directory left it: a registry stamped v1 without
 * `db_path`, and, for `move`, the database file back inside the directory.
 */
async function downgradeToVersionOne(
  home: string,
  record: ProjectRecord,
  database: LegacyDatabase = 'move',
): Promise<void> {
  const legacy = legacyDatabase(record)
  if (database === 'move') await rename(record.dbPath, legacy)
  if (database === 'copy') await copyFile(record.dbPath, legacy)
  if (database === 'missing') await rm(record.dbPath, { force: true })
  const registry = new DatabaseSync(join(home, 'mwf', 'projects.db'))
  try {
    registry.exec('ALTER TABLE projects DROP COLUMN db_path')
    registry.exec('PRAGMA user_version = 1')
    registry.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('workflow-projects/1', 'format')
  } finally {
    registry.close()
  }
}

/** Write rows through a second connection, the way another process would. */
async function seed(record: ProjectRecord, statements: (db: DatabaseSync) => void): Promise<void> {
  const db = new DatabaseSync(record.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    statements(db)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

/** Record one activation and one attempt so outbox rows satisfy their foreign key. */
async function seedAttempt(record: ProjectRecord, attemptId = 'attempt-1'): Promise<AttemptId> {
  await seed(record, (db) => {
    db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('run-1', 1, 'running', 10, 11)
    db.prepare('INSERT INTO activations (activation_id, run_id, node_id, iteration, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('activation-1', 'run-1', 'node-1', 0, 'running', 12, 12)
    db.prepare('INSERT INTO attempts (attempt_id, activation_id, attempt_no, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(attemptId, 'activation-1', 1, 'running', 13)
  })
  return brandString<AttemptId>(attemptId)
}

describe('project registry', () => {
  it('registers a project under the harness home and materializes its directory and database', async () => {
    const { store, home } = await openStore()
    const before = Date.now()
    const record = await store.createProject({ title: '  Release pipeline  ' })

    expect(record.title).toBe('Release pipeline')
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(record.path).toBe(join(home, 'mwf', 'projects', record.id, 'workspace'))
    expect(record.dbPath).toBe(join(home, 'mwf', 'projects', record.id, 'project.db'))
    expect(record.definitionRevision).toBe(0)
    expect(record.createdAt).toBeGreaterThanOrEqual(before)
    expect(record.updatedAt).toBe(record.createdAt)
    expect(existsSync(join(home, 'mwf', 'projects.db'))).toBe(true)
    expect(existsSync(record.path)).toBe(true)
    expect(existsSync(record.dbPath)).toBe(true)
    // The working directory holds no store file, so it can be moved or deleted.
    expect(readdirSync(record.path)).toEqual([])

    await expect(store.listProjects()).resolves.toEqual([record])
    await expect(store.openProject(record.id)).resolves.toEqual(record)
  })

  it('stamps the registry database with its own identity and version', async () => {
    const { store, home } = await openStore()
    await store.createProject({ title: 'stamped' })
    await store.close()
    const db = new DatabaseSync(join(home, 'mwf', 'projects.db'))
    try {
      expect(db.prepare('PRAGMA application_id').get()).toEqual({ application_id: WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID })
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION })
    } finally {
      db.close()
    }
  })

  it('lists projects newest first', async () => {
    const { store } = await openStore()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(now)
      const first = await store.createProject({ title: 'first' })
      clock.mockReturnValue(now + 1_000)
      const second = await store.createProject({ title: 'second' })
      const listed = await store.listProjects()
      expect(listed.map(project => project.id)).toEqual([second.id, first.id])
    } finally {
      clock.mockRestore()
    }
  })

  it('registers a project at an explicit directory but keeps its database under the home', async () => {
    const { store, home } = await openStore()
    const directory = await mkdtemp(join(tmpdir(), 'mwf-project-store-explicit-'))
    directories.push(directory)
    const record = await store.createProject({ title: 'explicit', path: directory })
    expect(record.path).toBe(directory)
    expect(record.dbPath).toBe(join(home, 'mwf', 'projects', record.id, 'project.db'))
    expect(existsSync(record.dbPath)).toBe(true)
    expect(existsSync(join(directory, 'project.db'))).toBe(false)
  })

  it('refuses a directory another project already uses', async () => {
    const { store } = await openStore()
    const directory = await mkdtemp(join(tmpdir(), 'mwf-project-store-taken-'))
    directories.push(directory)
    await store.createProject({ title: 'first', path: directory })
    await expect(store.createProject({ title: 'second', path: directory }))
      .rejects.toMatchObject({ code: 'project-path-in-use' })
    await expect(store.listProjects()).resolves.toHaveLength(1)
  })

  it('refuses an empty title', async () => {
    const { store } = await openStore()
    await expect(store.createProject({ title: '   ' })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('refuses a project directory under a regular file and writes no registry row', async () => {
    const { store, home } = await openStore()
    const occupied = join(home, 'occupied')
    await writeFile(occupied, 'not a directory')
    const error = await store.createProject({ title: 'broken', path: occupied }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(WorkflowProjectStoreError)
    expect(error).toMatchObject({ code: 'open-failed' })
    await expect(store.listProjects()).resolves.toEqual([])
  })

  it('keeps a database failure typed and writes no registry row', async () => {
    const home = await temporaryHome()
    const directory = await mkdtemp(join(tmpdir(), 'mwf-project-store-store-root-'))
    directories.push(directory)
    // The store's own project root is unusable while the registry itself opens.
    await mkdir(join(home, 'mwf'), { recursive: true })
    await writeFile(join(home, 'mwf', 'projects'), 'not a directory')
    const store = new Store(new Context(), { mwfHome: home })
    stores.push(store)

    const error = await store.createProject({ title: 'unusable root', path: directory })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(WorkflowProjectStoreError)
    expect(error).toMatchObject({ code: 'open-failed' })
    await expect(store.listProjects()).resolves.toEqual([])
  })

  it('refuses a project id that is not a canonical identifier', async () => {
    const { store } = await openStore()
    await expect(store.openProject('../../etc/passwd' as ProjectId)).rejects.toMatchObject({ code: 'invalid-project-id' })
    await expect(store.removeProject('not-an-id' as ProjectId)).rejects.toMatchObject({ code: 'invalid-project-id' })
  })

  it('refuses a project id that is not registered', async () => {
    const { store } = await openStore()
    const id = ghostId()
    await expect(store.openProject(id)).rejects.toMatchObject({ code: 'project-not-found' })
    await expect(store.readDefinition(id)).rejects.toMatchObject({ code: 'project-not-found' })
    await expect(store.listRuns(id)).rejects.toMatchObject({ code: 'project-not-found' })
    await expect(store.listOutbox(id, brandString<AttemptId>('attempt-1'))).rejects.toMatchObject({ code: 'project-not-found' })
    await expect(store.removeProject(id)).rejects.toMatchObject({ code: 'project-not-found' })
  })
})

describe('definitions', () => {
  it('stores revisions in order and refreshes the registry hint', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'definitions' })
    expect(await store.readDefinition(project.id)).toBeUndefined()

    expect(await store.writeDefinition(project.id, 'graph TD; A-->B')).toBe(1)
    expect(await store.writeDefinition(project.id, 'graph TD; B-->C')).toBe(2)

    expect(await store.readDefinition(project.id)).toMatchObject({ revision: 2, document: 'graph TD; B-->C' })
    expect(await store.readDefinition(project.id, 1)).toMatchObject({ revision: 1, document: 'graph TD; A-->B' })
    expect(await store.readDefinition(project.id, 7)).toBeUndefined()

    const [record] = await store.listProjects()
    expect(record?.definitionRevision).toBe(2)
    expect(record?.updatedAt).toBeGreaterThanOrEqual(record?.createdAt ?? 0)
  })

  it('refuses an empty document and a non-positive revision', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'invalid' })
    await expect(store.writeDefinition(project.id, '   ')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.readDefinition(project.id, 0)).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.readDefinition(project.id, 1.5)).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('gives concurrent definition writes distinct consecutive revisions', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'concurrent definitions' })
    const revisions = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => store.writeDefinition(project.id, `document ${String(index)}`)),
    )
    expect([...revisions].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5])
    const stored = await Promise.all(revisions.map(async revision => store.readDefinition(project.id, revision)))
    expect(new Set(stored.map(definition => definition?.document)).size).toBe(5)
  })
})

describe('runs', () => {
  it('lists runs newest first with their stored status', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'runs' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await seed(project, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
        .run('run-old', 1, 'succeeded', 20, 25, 'finished')
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
        .run('run-new', 1, 'running', 40, 41, null)
    })
    await expect(store.listRuns(project.id)).resolves.toEqual([
      {
        runId: 'run-new',
        definitionRevision: 1,
        status: 'running',
        createdAt: 40,
        updatedAt: 41,
        reason: null,
      },
      {
        runId: 'run-old',
        definitionRevision: 1,
        status: 'succeeded',
        createdAt: 20,
        updatedAt: 25,
        reason: 'finished',
      },
    ])
  })

  it('accepts a paused run as a declared status', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'paused run' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await store.transact(project.id, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
        .run('run-paused', 1, 'paused', 10, 11, 'paused by a human')
    })
    await expect(store.listRuns(project.id)).resolves.toEqual([
      {
        runId: 'run-paused',
        definitionRevision: 1,
        status: 'paused',
        createdAt: 10,
        updatedAt: 11,
        reason: 'paused by a human',
      },
    ])
  })

  it('refuses a stored status outside the declared vocabulary', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'unknown status' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await seed(project, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('run-exploded', 1, 'exploded', 1, 2)
    })
    await expect(store.listRuns(project.id)).rejects.toMatchObject({ code: 'invalid-record' })
  })
})

describe('session outbox', () => {
  it('stages events idempotently and acknowledges each event once', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'outbox' })
    await store.writeDefinition(project.id, 'graph TD; A')
    const attempt = await seedAttempt(project)

    const first = await store.appendOutbox(project.id, attempt, 0, '{"type":"attempt/start"}')
    expect(first).toEqual({ attemptId: attempt, eventSeq: 0, payload: '{"type":"attempt/start"}', ackedAt: null })
    await expect(store.appendOutbox(project.id, attempt, 0, '{"type":"duplicate"}')).resolves.toEqual(first)
    await store.appendOutbox(project.id, attempt, 1, '{"type":"attempt/end"}')
    await expect(store.listOutbox(project.id, attempt)).resolves.toMatchObject([
      { eventSeq: 0, payload: '{"type":"attempt/start"}' },
      { eventSeq: 1, payload: '{"type":"attempt/end"}' },
    ])

    await expect(store.markAcked(project.id, attempt, 1)).resolves.toBe(true)
    await expect(store.markAcked(project.id, attempt, 1)).resolves.toBe(false)
    await expect(store.markAcked(project.id, attempt, 9)).resolves.toBe(false)
    const acknowledged = await store.listOutbox(project.id, attempt)
    expect(acknowledged[1]?.ackedAt).toBeTypeOf('number')
    // Re-staging an acknowledged event keeps both the stored payload and the acknowledgement.
    await expect(store.appendOutbox(project.id, attempt, 1, '{"type":"again"}')).resolves.toMatchObject({
      payload: '{"type":"attempt/end"}',
      ackedAt: expect.any(Number) as number,
    })
  })

  it('refuses an attempt the project database does not hold and leaves nothing behind', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'unknown attempt' })
    await store.writeDefinition(project.id, 'graph TD; A')
    const ghost = brandString<AttemptId>('attempt-ghost')
    await expect(store.appendOutbox(project.id, ghost, 0, '{"type":"attempt/start"}'))
      .rejects.toMatchObject({ code: 'unknown-attempt' })
    await expect(store.listOutbox(project.id, ghost)).resolves.toEqual([])
  })

  it('refuses an empty payload and a negative sequence', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'invalid outbox' })
    await store.writeDefinition(project.id, 'graph TD; A')
    const attempt = await seedAttempt(project)
    await expect(store.appendOutbox(project.id, attempt, 0, '')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.appendOutbox(project.id, attempt, -1, '{"type":"x"}'))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.appendOutbox(project.id, attempt, 0.5, '{"type":"x"}'))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.markAcked(project.id, attempt, -2)).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('serializes concurrent appends without losing or duplicating events', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'concurrent outbox' })
    await store.writeDefinition(project.id, 'graph TD; A')
    const attempt = await seedAttempt(project)

    await Promise.all(Array.from(
      { length: 20 },
      (_unused, index) => store.appendOutbox(project.id, attempt, index, `{"eventSeq":${String(index)}}`),
    ))
    const stored = await store.listOutbox(project.id, attempt)
    expect(stored.map(event => event.eventSeq)).toEqual(Array.from({ length: 20 }, (_unused, index) => index))

    const [left, right] = await Promise.all([
      store.appendOutbox(project.id, attempt, 20, 'first writer'),
      store.appendOutbox(project.id, attempt, 20, 'second writer'),
    ])
    expect(left.payload).toBe('first writer')
    expect(right.payload).toBe('first writer')
    await expect(store.listOutbox(project.id, attempt)).resolves.toHaveLength(21)
  })
})

describe('project isolation', () => {
  it('keeps definitions and events inside their own project database', async () => {
    const { store } = await openStore()
    const first = await store.createProject({ title: 'first project' })
    const second = await store.createProject({ title: 'second project' })
    expect(first.path).not.toBe(second.path)

    await store.writeDefinition(first.id, 'document of the first project')
    await expect(store.readDefinition(second.id)).resolves.toBeUndefined()
    await store.writeDefinition(second.id, 'document of the second project')
    await expect(store.readDefinition(first.id)).resolves.toMatchObject({ document: 'document of the first project' })
    await expect(store.readDefinition(second.id)).resolves.toMatchObject({ document: 'document of the second project' })

    const attempt = await seedAttempt(first)
    await store.appendOutbox(first.id, attempt, 0, '{"type":"first"}')
    await expect(store.listOutbox(second.id, attempt)).resolves.toEqual([])
  })
})

describe('working directory isolation', () => {
  it('keeps the registry row and the database when the working directory is deleted', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'movable' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await rm(project.path, { recursive: true, force: true })

    const [listed] = await store.listProjects()
    expect(listed).toMatchObject({ id: project.id, path: project.path, dbPath: project.dbPath, definitionRevision: 1 })
    await expect(store.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; A' })
    await expect(store.openProject(project.id)).rejects.toMatchObject({ code: 'project-directory-missing' })

    // A later process reports the same diagnosable failure instead of crashing.
    await store.close()
    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    await expect(reopened.listProjects()).resolves.toHaveLength(1)
    await expect(reopened.openProject(project.id)).rejects.toMatchObject({ code: 'project-directory-missing' })
    await expect(reopened.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; A' })
  })

  it('reports a working directory that was replaced by a file', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'replaced' })
    await rm(project.path, { recursive: true, force: true })
    await writeFile(project.path, 'not a directory')
    try {
      await expect(store.openProject(project.id)).rejects.toMatchObject({ code: 'project-directory-missing' })
    } finally {
      await rm(project.path, { force: true })
    }
  })
})

describe('scheduler transactions', () => {
  it('commits one synchronous body and returns its result', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'transact' })
    await store.writeDefinition(project.id, 'graph TD; A')

    const written = await store.transact(project.id, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('run-1', 1, 'running', 10, 10)
      return db.prepare('SELECT COUNT(*) AS runs FROM runs').get()
    })
    expect(written).toEqual({ runs: 1 })
    await expect(store.listRuns(project.id)).resolves.toMatchObject([{ runId: 'run-1', status: 'running' }])
  })

  it('rolls the whole batch back when the body throws', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'rollback' })
    await store.writeDefinition(project.id, 'graph TD; A')

    await expect(store.transact(project.id, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('run-1', 1, 'running', 10, 10)
      throw new Error('the batch failed')
    })).rejects.toThrow('the batch failed')
    await expect(store.listRuns(project.id)).resolves.toEqual([])
  })

  it('serializes transactions with the store queue and refuses unknown projects', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'serialized' })
    await store.writeDefinition(project.id, 'graph TD; A')

    const order: string[] = []
    const first = store.transact(project.id, () => {
      order.push('first')
      return 1
    })
    const second = store.transact(project.id, () => {
      order.push('second')
      return 2
    })
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first', 'second'])
    await expect(store.transact(ghostId(), () => 1)).rejects.toMatchObject({ code: 'project-not-found' })
  })
})

describe('database relocation', () => {
  it('moves a v1 database out of the working directory on first open and keeps its content', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'legacy' })
    await store.writeDefinition(project.id, 'graph TD; legacy')
    const [current] = await store.listProjects() as [ProjectRecord]
    await store.close()
    await downgradeToVersionOne(home, project)
    expect(existsSync(legacyDatabase(project))).toBe(true)
    expect(existsSync(project.dbPath)).toBe(false)

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    // The upgraded registry still names the file inside the working directory.
    const [before] = await reopened.listProjects()
    expect(before).toMatchObject({ path: project.path, dbPath: legacyDatabase(project), definitionRevision: 1 })
    expect(before?.updatedAt).toBe(current.updatedAt)

    await expect(reopened.openProject(project.id)).resolves.toEqual({ ...current, dbPath: project.dbPath })
    expect(existsSync(project.dbPath)).toBe(true)
    expect(existsSync(legacyDatabase(project))).toBe(false)
    await expect(reopened.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; legacy' })

    // Moving the file is bookkeeping: the row names the new path, its change
    // stamp and every other column stay as the caller left them.
    await expect(reopened.listProjects()).resolves.toEqual([{ ...current, dbPath: project.dbPath }])
  })

  it('repeats an open without copying anything twice', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'idempotent' })
    await store.writeDefinition(project.id, 'graph TD; once')
    const [current] = await store.listProjects() as [ProjectRecord]
    await store.close()
    await downgradeToVersionOne(home, project)

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    await reopened.openProject(project.id)
    await reopened.openProject(project.id)
    await reopened.close()

    const third = new Store(new Context(), { mwfHome: home })
    stores.push(third)
    await expect(third.openProject(project.id)).resolves.toEqual({ ...current, dbPath: project.dbPath })
    await expect(third.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; once' })
    expect(existsSync(legacyDatabase(project))).toBe(false)
    const files = readdirSync(join(home, 'mwf', 'projects', project.id))
    expect(files.filter(name => !name.startsWith('project.db-')).sort()).toEqual(['project.db', 'workspace'])
  })

  it('creates the database at the canonical path when the old location holds none', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'no database' })
    await store.close()
    await downgradeToVersionOne(home, project, 'missing')

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    await expect(reopened.openProject(project.id)).resolves.toMatchObject({ dbPath: project.dbPath })
    await expect(reopened.readDefinition(project.id)).resolves.toBeUndefined()
    expect(existsSync(legacyDatabase(project))).toBe(false)
    await expect(reopened.listProjects()).resolves.toEqual([{ ...project, dbPath: project.dbPath }])
  })

  it('keeps the recorded canonical database and warns about a stale copy', async () => {
    const home = await temporaryHome()
    const store = new Store(new Context(), { mwfHome: home })
    stores.push(store)
    const project = await store.createProject({ title: 'stale copy' })
    await store.writeDefinition(project.id, 'graph TD; kept')
    await store.close()
    // A copy left behind by an interrupted move, with the canonical file intact.
    await downgradeToVersionOne(home, project, 'copy')
    const ctx = new Context()
    const reopened = new Store(ctx, { mwfHome: home })
    stores.push(reopened)
    const warn = vi.spyOn(ctx.logger, 'warn')

    await expect(reopened.openProject(project.id)).resolves.toMatchObject({ dbPath: project.dbPath })
    await expect(reopened.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; kept' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale database copy'))
    expect(existsSync(legacyDatabase(project))).toBe(true)
  })

  it('fails the open and keeps the old database when the move cannot complete', async () => {
    const { store, home } = await openStore()
    const workspace = await mkdtemp(join(tmpdir(), 'mwf-project-store-blocked-'))
    directories.push(workspace)
    const project = await store.createProject({ title: 'blocked', path: workspace })
    await store.writeDefinition(project.id, 'graph TD; intact')
    await store.close()
    await downgradeToVersionOne(home, project)
    const storeDirectory = join(home, 'mwf', 'projects', project.id)
    await rm(storeDirectory, { recursive: true, force: true })
    await writeFile(storeDirectory, 'not a directory')

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    const error = await reopened.openProject(project.id).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(WorkflowProjectStoreError)
    expect(error).toMatchObject({ code: 'relocation-failed' })
    expect((error as WorkflowProjectStoreError).message)
      .toContain(`could not be moved to "${project.dbPath}"`)
    expect(existsSync(legacyDatabase(project))).toBe(true)
    const [pending] = await reopened.listProjects()
    expect(pending?.dbPath).toBe(legacyDatabase(project))

    // Rollback: clearing the obstacle lets the same row open and keep its content.
    await rm(storeDirectory, { force: true })
    await expect(reopened.openProject(project.id)).resolves.toMatchObject({ dbPath: project.dbPath })
    await expect(reopened.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; intact' })
  })
})

describe('removeProject', () => {
  it('removes the registry row and keeps the directory by default', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'kept' })

    await expect(store.removeProject(project.id)).resolves.toBe(project.path)
    await expect(store.listProjects()).resolves.toEqual([])
    expect(existsSync(project.path)).toBe(true)
    expect(existsSync(project.dbPath)).toBe(true)
    await expect(store.openProject(project.id)).rejects.toMatchObject({ code: 'project-not-found' })

    const again = await store.createProject({ title: 're-registered', path: project.path })
    expect(again.path).toBe(project.path)
    await expect(store.readDefinition(again.id)).resolves.toBeUndefined()
  })

  it('deletes the working directory and the project database when asked', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'deleted' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await expect(store.removeProject(project.id, { deleteDirectory: true })).resolves.toBe(project.path)
    expect(existsSync(project.path)).toBe(false)
    expect(existsSync(join(home, 'mwf', 'projects', project.id))).toBe(false)
    await expect(store.listProjects()).resolves.toEqual([])
  })

  it('removes a project this process never opened', async () => {
    const { store, home } = await openStore()
    await store.listProjects()
    const registry = new DatabaseSync(join(home, 'mwf', 'projects.db'))
    const id = ghostId()
    const workspace = join(home, 'mwf', 'projects', id, 'workspace')
    try {
      registry.prepare('INSERT INTO projects (id, path, db_path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, workspace, join(home, 'mwf', 'projects', id, 'project.db'), 'Seeded elsewhere', 1, 1, 0)
    } finally {
      registry.close()
    }
    await expect(store.removeProject(id)).resolves.toBe(workspace)
    await expect(store.listProjects()).resolves.toEqual([])
  })
})

describe('durable layout', () => {
  it('refuses a project database with another layout version', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'stale project database' })
    await store.close()
    const db = new DatabaseSync(project.dbPath)
    db.exec('PRAGMA user_version = 99')
    db.close()

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    await expect(reopened.openProject(project.id)).rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('upgrades a v1 project database to the scheduler columns', async () => {
    const { store, home } = await openStore()
    const project = await store.createProject({ title: 'v1 project database' })
    await store.writeDefinition(project.id, 'graph TD; A')
    await store.close()

    // A project database written before the scheduler columns existed.
    const db = new DatabaseSync(project.dbPath)
    db.exec('ALTER TABLE runs DROP COLUMN params_json')
    db.exec('ALTER TABLE activations DROP COLUMN incoming_json')
    db.exec('ALTER TABLE attempts DROP COLUMN result_json')
    db.exec('PRAGMA user_version = 1')
    db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('workflow-project/1', 'format')
    db.close()

    const reopened = new Store(new Context(), { mwfHome: home })
    stores.push(reopened)
    await expect(reopened.openProject(project.id)).resolves.toMatchObject({ dbPath: project.dbPath })
    const value = await reopened.transact(project.id, (connection) => {
      const { user_version: version } = connection.prepare('PRAGMA user_version').get() as { user_version: number }
      const columns = connection.prepare('PRAGMA table_info(runs)').all().map(row => row.name)
      const format = connection.prepare("SELECT value FROM schema_meta WHERE key = 'format'").get()
      return { version, columns, format }
    })
    expect(value.version).toEqual(WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION)
    expect(value.columns).toContain('params_json')
    expect(value.format).toEqual({ value: 'workflow-project/2' })
    await expect(reopened.readDefinition(project.id)).resolves.toMatchObject({ document: 'graph TD; A' })
  })

  it('refuses a registry row that records no database path', async () => {
    const { store, home } = await openStore()
    await store.listProjects()
    const registry = new DatabaseSync(join(home, 'mwf', 'projects.db'))
    const id = ghostId()
    try {
      registry.prepare('INSERT INTO projects (id, path, db_path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, join(home, 'mwf', 'projects', id, 'workspace'), '', 'No database', 1, 1, 0)
    } finally {
      registry.close()
    }
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'invalid-record' })
    await expect(store.openProject(id)).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('refuses a registry database with another layout version', async () => {
    const home = await temporaryHome()
    await mkdir(join(home, 'mwf'), { recursive: true })
    const db = new DatabaseSync(join(home, 'mwf', 'projects.db'))
    db.exec(`PRAGMA application_id = ${String(WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID)}`)
    db.exec('PRAGMA user_version = 42')
    db.close()

    const store = new Store(new Context(), { mwfHome: home })
    stores.push(store)
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'version-mismatch' })
  })
})

describe('service lifetime', () => {
  it('refuses work after close and closes twice', async () => {
    const { store } = await openStore()
    const project = await store.createProject({ title: 'closing' })
    await store.close()

    await expect(store.listProjects()).rejects.toMatchObject({ code: 'closed' })
    await expect(store.createProject({ title: 'new' })).rejects.toMatchObject({ code: 'closed' })
    await expect(store.openProject(project.id)).rejects.toMatchObject({ code: 'closed' })
    await expect(store.removeProject(project.id)).rejects.toMatchObject({ code: 'closed' })
    await expect(store.readDefinition(project.id)).rejects.toMatchObject({ code: 'closed' })
    await expect(store.writeDefinition(project.id, 'document')).rejects.toMatchObject({ code: 'closed' })
    await expect(store.listRuns(project.id)).rejects.toMatchObject({ code: 'closed' })
    await expect(store.listOutbox(project.id, brandString<AttemptId>('attempt-1')))
      .rejects.toMatchObject({ code: 'closed' })
    await expect(store.appendOutbox(project.id, brandString<AttemptId>('attempt-1'), 0, '{}'))
      .rejects.toMatchObject({ code: 'closed' })
    await expect(store.markAcked(project.id, brandString<AttemptId>('attempt-1'), 0))
      .rejects.toMatchObject({ code: 'closed' })
    await expect(store.transact(project.id, () => 1)).rejects.toMatchObject({ code: 'closed' })
    await expect(store.close()).resolves.toBeUndefined()
  })

  it('registers ctx.mwfProjectStore and closes it with the plugin fiber', async () => {
    const home = await temporaryHome()
    const ctx = new Context()
    const fiber = await ctx.plugin(Store, { mwfHome: home })
    const store = ctx.mwfProjectStore
    const project = await store.createProject({ title: 'mounted' })
    expect(existsSync(project.path)).toBe(true)
    await fiber.dispose()
    await expect(store.listProjects()).rejects.toMatchObject({ code: 'closed' })
  })

  it('resolves the harness home from MWF_HOME when the composition sets none', async () => {
    const home = await temporaryHome()
    const previous = process.env.MWF_HOME
    process.env.MWF_HOME = home
    const ctx = new Context()
    try {
      const fiber = await ctx.plugin(Store, {})
      const store = ctx.mwfProjectStore
      const project = await store.createProject({ title: 'environment home' })
      expect(project.path).toBe(join(home, 'mwf', 'projects', project.id, 'workspace'))
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.MWF_HOME
      else process.env.MWF_HOME = previous
    }
  })
})

describe('project rename', () => {
  it('replaces the title and stamps the change, keeping the directory key', async () => {
    const { store, home } = await openStore()
    const created = await store.createProject({ title: 'Before' })
    const renamed = await store.renameProject(created.id, '  After  ')
    expect(renamed).toMatchObject({ id: created.id, path: created.path, title: 'After' })
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
    expect((await store.listProjects())[0]).toMatchObject({ id: created.id, title: 'After' })
    expect(created.path.startsWith(home)).toBe(true)
    await expect(store.createProject({ title: 'Same directory', path: created.path }))
      .rejects.toMatchObject({ code: 'project-path-in-use' })
  })

  it('refuses a blank title, an unknown project, and a non-canonical id', async () => {
    const { store } = await openStore()
    const created = await store.createProject({ title: 'Kept' })
    await expect(store.renameProject(created.id, '   ')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(store.renameProject(ghostId(), 'Title')).rejects.toMatchObject({ code: 'project-not-found' })
    await expect(store.renameProject(brandString<ProjectId>('not-a-uuid'), 'Title'))
      .rejects.toMatchObject({ code: 'invalid-project-id' })
    expect((await store.listProjects())[0]!.title).toBe('Kept')
  })
})

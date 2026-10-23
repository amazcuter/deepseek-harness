import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  openProjectDatabase,
  openRegistryDatabase,
  openWorkflowDatabase,
  WorkflowProjectStoreError,
  WORKFLOW_PROJECT_DATABASE_APPLICATION_ID,
  WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION,
  WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID,
  WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION,
  WORKFLOW_STORE_BUSY_TIMEOUT_MS,
} from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mwf-project-store-open-'))
  directories.push(directory)
  return directory
}

/** A materializer that proves the schema statements ran inside the protocol. */
function markerSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS marker (value TEXT NOT NULL) STRICT')
}

function pragmaOf(db: DatabaseSync, pragma: string): unknown {
  return db.prepare(`PRAGMA ${pragma}`).get()
}

async function createDatabase(path: string, statements: string): Promise<void> {
  const db = new DatabaseSync(path)
  db.exec(statements)
  db.close()
}

describe('openWorkflowDatabase', () => {
  it('creates the medium owner-only and applies the connection pragmas', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'nested', 'store.db')
    const db = await openWorkflowDatabase({
      path,
      applicationId: 0x1234,
      schemaVersion: 3,
      materialize: markerSchema,
      busyTimeoutMs: 777,
    })
    try {
      expect(existsSync(path)).toBe(true)
      expect(pragmaOf(db, 'busy_timeout')).toEqual({ timeout: 777 })
      expect(pragmaOf(db, 'journal_mode')).toEqual({ journal_mode: 'wal' })
      expect(pragmaOf(db, 'foreign_keys')).toEqual({ foreign_keys: 1 })
      expect(pragmaOf(db, 'application_id')).toEqual({ application_id: 0x1234 })
      expect(pragmaOf(db, 'user_version')).toEqual({ user_version: 3 })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      expect(tables.map(row => row.name)).toEqual(['marker'])
    } finally {
      db.close()
    }
  })

  it('uses the default busy timeout and reopens an existing medium without re-stamping', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    const first = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
    expect(pragmaOf(first, 'busy_timeout')).toEqual({ timeout: WORKFLOW_STORE_BUSY_TIMEOUT_MS })
    first.prepare('INSERT INTO marker (value) VALUES (?)').run('kept')
    first.close()

    const second = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
    try {
      expect(second.prepare('SELECT value FROM marker').all()).toEqual([{ value: 'kept' }])
      expect(pragmaOf(second, 'user_version')).toEqual({ user_version: 2 })
    } finally {
      second.close()
    }
  })

  it('finishes an interrupted materialization that carries its own identity', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, 'PRAGMA application_id = 9')
    const db = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
    try {
      expect(pragmaOf(db, 'application_id')).toEqual({ application_id: 9 })
      expect(pragmaOf(db, 'user_version')).toEqual({ user_version: 2 })
      expect(db.prepare('SELECT value FROM marker').all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects a database stamped with another layout version', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, 'PRAGMA application_id = 9; PRAGMA user_version = 99')
    const error = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'version-mismatch' })
    expect((error as WorkflowProjectStoreError).message).toMatch(/schema version 99, incompatible with this build \(2\)/)
  })

  it('brings an older database forward through every declared upgrade', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, [
      'PRAGMA application_id = 9',
      'PRAGMA user_version = 1',
      'CREATE TABLE marker (value TEXT NOT NULL) STRICT',
    ].join('; '))
    const applied: number[] = []
    const db = await openWorkflowDatabase({
      path,
      applicationId: 9,
      schemaVersion: 3,
      materialize: markerSchema,
      upgrades: [
        {
          from: 1,
          apply: (connection) => {
            applied.push(1)
            connection.exec('ALTER TABLE marker ADD COLUMN after_first TEXT')
          },
        },
        {
          from: 2,
          apply: (connection) => {
            applied.push(2)
            connection.exec('ALTER TABLE marker ADD COLUMN after_second TEXT')
          },
        },
      ],
    })
    try {
      expect(applied).toEqual([1, 2])
      expect(pragmaOf(db, 'user_version')).toEqual({ user_version: 3 })
      expect(db.prepare('PRAGMA table_info(marker)').all().map(row => row.name))
        .toEqual(['value', 'after_first', 'after_second'])
    } finally {
      db.close()
    }
  })

  it('rolls a failed upgrade back and leaves the stored version', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, [
      'PRAGMA application_id = 9',
      'PRAGMA user_version = 1',
      'CREATE TABLE marker (value TEXT NOT NULL) STRICT',
    ].join('; '))
    const error = await openWorkflowDatabase({
      path,
      applicationId: 9,
      schemaVersion: 2,
      materialize: markerSchema,
      upgrades: [{
        from: 1,
        apply: (connection) => {
          connection.exec('ALTER TABLE marker ADD COLUMN half_done TEXT')
          throw new Error('upgrade interrupted')
        },
      }],
    }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'open-failed' })

    const db = new DatabaseSync(path)
    try {
      expect(pragmaOf(db, 'user_version')).toEqual({ user_version: 1 })
      expect(db.prepare('PRAGMA table_info(marker)').all().map(row => row.name)).toEqual(['value'])
    } finally {
      db.close()
    }
  })

  it('rejects a database that belongs to another application', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, 'PRAGMA application_id = 4242')
    const error = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(WorkflowProjectStoreError)
    expect(error).toMatchObject({ code: 'foreign-database' })
  })

  it('rejects a non-empty database without the store identity', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await createDatabase(path, 'CREATE TABLE stranger (value TEXT)')
    await expect(openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema }))
      .rejects.toMatchObject({ code: 'foreign-database' })
  })

  it('rejects a file that is not a database and releases it', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'store.db')
    await writeFile(path, 'this file is not a SQLite database')
    const error = await openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema })
      .catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'open-failed' })
    expect((error as WorkflowProjectStoreError).cause).toBeDefined()
    // A leaked handle would keep the file locked on Windows.
    await rm(path, { force: true })
  })

  it('reports a filesystem failure under a regular file', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'occupied')
    await writeFile(file, 'x')
    await expect(openWorkflowDatabase({
      path: join(file, 'store.db'),
      applicationId: 9,
      schemaVersion: 2,
      materialize: markerSchema,
    })).rejects.toMatchObject({ code: 'open-failed' })
  })

  it('reports a database path that is a directory', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'as-directory')
    await mkdir(path)
    await expect(openWorkflowDatabase({ path, applicationId: 9, schemaVersion: 2, materialize: markerSchema }))
      .rejects.toMatchObject({ code: 'open-failed' })
  })

  it('retries the WAL switch while another connection holds the file', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'busy.db')
    const holder = new DatabaseSync(path)
    holder.exec('PRAGMA journal_mode = DELETE')
    // The holder marks the file with the store identity so the retried open
    // reaches its schema statements instead of rejecting a foreign table.
    holder.exec('PRAGMA application_id = 9')
    holder.exec('CREATE TABLE holder (value TEXT)')
    holder.exec('BEGIN IMMEDIATE')
    holder.prepare('INSERT INTO holder (value) VALUES (?)').run('held')
    let released = false
    const db = await openWorkflowDatabase({
      path,
      applicationId: 9,
      schemaVersion: 2,
      materialize: markerSchema,
      busyTimeoutMs: 1,
      walRetryAttempts: 3,
      walRetryDelayMs: 1,
      delay: async () => {
        if (released) return
        released = true
        holder.exec('COMMIT')
      },
    })
    try {
      expect(released).toBe(true)
      expect(pragmaOf(db, 'journal_mode')).toEqual({ journal_mode: 'wal' })
    } finally {
      db.close()
      holder.close()
    }
  })

  it('waits on a real timer between WAL attempts', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'timed.db')
    const holder = new DatabaseSync(path)
    holder.exec('PRAGMA journal_mode = DELETE')
    holder.exec('PRAGMA application_id = 9')
    holder.exec('CREATE TABLE holder (value TEXT)')
    holder.exec('BEGIN IMMEDIATE')
    holder.prepare('INSERT INTO holder (value) VALUES (?)').run('held')
    const release = setTimeout(() => {
      holder.exec('COMMIT')
    }, 300)
    try {
      const db = await openWorkflowDatabase({
        path,
        applicationId: 9,
        schemaVersion: 2,
        materialize: markerSchema,
        busyTimeoutMs: 1,
        walRetryAttempts: 8,
        walRetryDelayMs: 40,
      })
      try {
        expect(pragmaOf(db, 'journal_mode')).toEqual({ journal_mode: 'wal' })
        expect(existsSync(path)).toBe(true)
      } finally {
        db.close()
      }
    } finally {
      clearTimeout(release)
      holder.close()
    }
  })

  it('fails when the file stays locked through the retry budget', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'locked.db')
    const holder = new DatabaseSync(path)
    holder.exec('CREATE TABLE holder (value TEXT)')
    holder.exec('BEGIN IMMEDIATE')
    holder.prepare('INSERT INTO holder (value) VALUES (?)').run('held')
    try {
      const error = await openWorkflowDatabase({
        path,
        applicationId: 9,
        schemaVersion: 2,
        materialize: markerSchema,
        busyTimeoutMs: 1,
        walRetryAttempts: 2,
        walRetryDelayMs: 1,
        delay: async () => {},
      }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 'open-failed' })
      expect((error as WorkflowProjectStoreError).message).toMatch(/stayed locked while switching to WAL after 2 attempts/)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })
})

describe('store database identities', () => {
  it('stamps the registry and project identities separately', async () => {
    const directory = await temporaryDirectory()
    const registry = join(directory, 'projects.db')
    const project = join(directory, 'project.db')
    const registryDb = await openRegistryDatabase(registry)
    const projectDb = await openProjectDatabase(project, { busyTimeoutMs: 1234 })
    try {
      expect(pragmaOf(registryDb, 'application_id')).toEqual({ application_id: WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID })
      expect(pragmaOf(registryDb, 'user_version')).toEqual({ user_version: WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION })
      expect(pragmaOf(projectDb, 'application_id')).toEqual({ application_id: WORKFLOW_PROJECT_DATABASE_APPLICATION_ID })
      expect(pragmaOf(projectDb, 'user_version')).toEqual({ user_version: WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION })
      expect(pragmaOf(projectDb, 'busy_timeout')).toEqual({ timeout: 1234 })
      expect(WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID).not.toBe(WORKFLOW_PROJECT_DATABASE_APPLICATION_ID)
      expect(registryDb.prepare("SELECT value FROM schema_meta WHERE key = 'format'").get())
        .toEqual({ value: 'workflow-projects/2' })
      expect(projectDb.prepare("SELECT value FROM schema_meta WHERE key = 'format'").get())
        .toEqual({ value: 'workflow-project/1' })
    } finally {
      registryDb.close()
      projectDb.close()
    }
  })

  it('refuses to open a registry database as a project database', async () => {
    const directory = await temporaryDirectory()
    const registry = join(directory, 'projects.db')
    const registryDb = await openRegistryDatabase(registry)
    registryDb.close()
    await expect(openProjectDatabase(registry)).rejects.toMatchObject({ code: 'foreign-database' })
  })

  it('declares every project table and index', async () => {
    const directory = await temporaryDirectory()
    const db = await openProjectDatabase(join(directory, 'project.db'))
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      expect(tables.map(row => row.name)).toEqual([
        'activations',
        'artifacts',
        'decisions',
        'definitions',
        'edges',
        'nodes',
        'runs',
        'schema_meta',
        'session_outbox',
        'attempts',
      ].sort())
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
      expect(indexes.map(row => row.name)).toEqual([
        'activations_by_run',
        'artifacts_by_activation',
        'attempts_by_activation',
        'decisions_by_activation',
        'edges_by_revision',
        'nodes_by_revision',
        'runs_by_created',
        'session_outbox_by_ack',
      ])
    } finally {
      db.close()
    }
  })
})

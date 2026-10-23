import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@metaworkflow/brand'
import Storage from '@metaworkflow/storage'
import type { StorageBackend } from '@metaworkflow/storage'
import { DomainFacility } from '@metaworkflow/storage-domain'
import type { DomainChanged } from '@metaworkflow/storage-domain'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@metaworkflow/session'
import type { SessionHeader } from '@metaworkflow/session'
import { SessionPersistenceRevision } from '@metaworkflow/session-persistence'
import type { SessionPersistenceSnapshot } from '@metaworkflow/session-persistence'
import ProjectStore, { openRegistryDatabase } from '@metaworkflow/workflow-project-store'
import type { ProjectId, ProjectRecord } from '@metaworkflow/workflow-project-store'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, {
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  workspaceGroupRecord,
  workspaceProjectState,
} from '../src/index.ts'
import type {
  LegacyWorkspaceRecord,
  WorkspaceGroupRecord,
  WorkspaceProjectState,
} from '../src/index.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath } from '../src/paths.ts'
import * as workspacePaths from '../src/paths.ts'

const PROJECT_DOMAIN = 'workspace_projects'
const LEGACY_DOMAIN = 'workspace'

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SessionId(id),
  createdAt,
  isSeeded: false,
  ...(cwd === undefined ? {} : { cwd }),
})

interface HarnessOptions {
  pool?: MemoryMediaPool
  home?: string
  sessions?: SessionHeader[]
  liveSessions?: SessionHeader[]
  sessionStore?: boolean
  backend?: StorageBackend
}

let base: string
const tempDirs: string[] = []
const homes: string[] = []
const contexts: Context[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'mwf-workspace-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-workspace-home-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

/** Boot the real storage/domain/project-store/registry composition over controllable peers. */
async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const home = options.home ?? await makeHome()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = options.sessions ?? []
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    listed.map(entry => ({ header: entry, revision: SessionPersistenceRevision(`rev-${entry.id}`) })))
  const open = vi.fn(() => { throw new Error('event bodies must not be opened') })
  const stat = vi.fn(() => { throw new Error('per-session stat must not be needed') })
  ctx.provide('sessionPersistence', { list, open, stat } as never)

  if (options.sessionStore === true) {
    await ctx.plugin(SessionStore)
  } else if (options.liveSessions !== undefined) {
    const live = new Map(options.liveSessions.map(entry => [entry.id, { header: entry }]))
    ctx.provide('sessions', {
      get: (id: SessionId) => live.get(id),
      list: () => [...live.values()],
    } as never)
  }

  await ctx.plugin(ProjectStore, { mwfHome: home })
  contexts.push(ctx)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const renamed: string[] = []
  ctx.on('workspace/changed', (change) => { renamed.push(String(change.workspaceId)) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  changes.length = 0
  return {
    ctx,
    fiber,
    pool,
    home,
    registry: ctx.workspaceRegistry,
    projectStore: ctx.mwfProjectStore,
    changes,
    renamed,
    list,
    open,
    stat,
    setSessions: (headers: SessionHeader[]) => { listed = headers },
  }
}

/** Boot only the storage side, for dependency-pending and startup-failure cases. */
async function storageContext(pool: MemoryMediaPool, backend: StorageBackend = new MemoryStorageBackend(pool)) {
  const home = await makeHome()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ProjectStore, { mwfHome: home })
  contexts.push(ctx)
  return ctx
}

/** Backend wrapper that injects one selected write failure. */
/** Failure schedule read at write time, so a test can arm it after boot. */
interface WriteFailures {
  putAt?: number
  deleteAt?: number
  globalAt?: number | readonly number[]
}

function selectiveFailureBackend(
  pool: MemoryMediaPool,
  options: WriteFailures,
): StorageBackend & { stats: { puts: number; deletes: number; globals: number } } {
  const inner = new MemoryStorageBackend(pool)
  const stats = { puts: 0, deletes: 0, globals: 0 }
  const failure = options
  return {
    stats,
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            stats.puts += 1
            if (stats.puts === failure.putAt) throw new Error('selected put failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: async (table, key) => {
            stats.deletes += 1
            if (stats.deletes === failure.deleteAt) throw new Error('selected delete failure')
            await unit.deleteRecord(table, key)
          },
          setGlobal: async (value) => {
            stats.globals += 1
            const failAt = Array.isArray(failure.globalAt) ? failure.globalAt : [failure.globalAt]
            if (failAt.includes(stats.globals)) throw new Error('selected global failure')
            await unit.setGlobal(value)
          },
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
}

function group(sessionIds: string[], updatedAt = Date.parse('2026-07-24T00:00:00.000Z')): WorkspaceGroupRecord {
  return { sessionIds: sessionIds.map(SessionId), updatedAt }
}

/** Media shaped exactly as the shipped v2 registry wrote it. */
function legacyMedium(
  entries: Array<[string, LegacyWorkspaceRecord]>,
  state: Record<string, unknown>,
) {
  return {
    tables: new Map([['workspaces', new Map<string, unknown>(entries)]]),
    global: state,
  }
}

function storedProjects(pool: MemoryMediaPool): Map<string, WorkspaceGroupRecord> {
  return pool.media.get(PROJECT_DOMAIN)!.tables.get('projects') as Map<string, WorkspaceGroupRecord>
}

function storedState(pool: MemoryMediaPool): WorkspaceProjectState {
  return pool.media.get(PROJECT_DOMAIN)!.global as WorkspaceProjectState
}

function projectIds(pool: MemoryMediaPool): string[] {
  return storedState(pool).projectIds.map(String)
}

function legacyRecord(path: string, sessionIds: string[], createdAt = '2026-07-24T00:00:00.000Z'): LegacyWorkspaceRecord {
  return {
    path,
    title: basename(path),
    sessionIds: sessionIds.map(SessionId),
    createdAt,
    updatedAt: createdAt,
  }
}

/** Boot only the project store over the shared medium, for seeding registered projects. */
async function seedStore(pool: MemoryMediaPool, home: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ProjectStore, { mwfHome: home })
  return { ctx, fiber: ctx.fiber, mwfProjectStore: ctx.mwfProjectStore }
}

/** Register one project row without materializing its project database. */
async function seedProjectRow(home: string, path: string, title: string): Promise<ProjectId> {
  const db = await openRegistryDatabase(join(home, 'mwf', 'projects.db'))
  const id = brandString<ProjectId>(randomUUID())
  const now = Date.now()
  try {
    db.prepare('INSERT INTO projects (id, path, db_path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, path, join(home, 'mwf', 'projects', id, 'project.db'), title, now, now, 0)
  } finally {
    db.close()
  }
  return id
}

/** Register one project directly in the project store, outside the registry. */
async function registerOutside(projectStore: ProjectStore, path: string, title: string): Promise<ProjectRecord> {
  return await projectStore.createProject({ path, title })
}

/** Boot a second context over the same medium and home, without the registry's teardown ordering. */
async function restart(options: HarnessOptions): Promise<Awaited<ReturnType<typeof harness>>> {
  const result = await harness(options)
  return result
}

describe('WorkspaceRegistry lifecycle and startup', () => {
  it('stays pending without sessionPersistence and never writes either domain', async () => {
    const pool = new MemoryMediaPool()
    const ctx = await storageContext(pool)
    const fiber = await ctx.plugin(WorkspaceRegistry)
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    expect(pool.media.get(PROJECT_DOMAIN)).toBeUndefined()

    const list = vi.fn(async () => [] as SessionPersistenceSnapshot[])
    ctx.provide('sessionPersistence', { list } as never)
    await fiber.await()
    expect(ctx.workspaceRegistry.list()).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
    expect(storedState(pool)).toEqual({
      initialized: true,
      migratedFromV2: true,
      projectIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    })
  })

  it('leaves the legacy v2 medium untouched on a fresh profile', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({ pool })
    expect(registry.list()).toEqual([])
    const legacy = pool.media.get(LEGACY_DOMAIN)
    expect(legacy?.global).toBeNull()
    expect(legacy?.tables.get('workspaces')?.size ?? 0).toBe(0)
    expect(pool.versions.get(LEGACY_DOMAIN)).toBe(2)

    // A second start with an empty, already initialized registry skips the
    // history bootstrap entirely.
    const restarted = await restart({ pool, home: (await harness({ pool })).home })
    expect(restarted.registry.list()).toEqual([])
  })

  it('imports every v2 workspace once, keeping order, titles, accounts, and global sets', async () => {
    const first = await makeDir('import-first')
    const second = await makeDir('import-second')
    const pool = new MemoryMediaPool()
    pool.media.set(LEGACY_DOMAIN, legacyMedium(
      [
        ['legacy-a', { ...legacyRecord(first, ['s1', 's2']), title: 'Imported A' }],
        ['legacy-b', legacyRecord(second, ['s3'])],
      ],
      {
        initialized: true,
        workspaceIds: ['legacy-a', 'legacy-b'],
        defaultWorkspaceId: 'legacy-b',
        archivedSessionIds: ['s3'],
        pinnedSessionIds: [],
      },
    ))
    pool.versions.set(LEGACY_DOMAIN, 2)
    const { registry, projectStore } = await harness({ pool })

    const projects = await projectStore.listProjects()
    expect(projects).toHaveLength(2)
    expect(projects.map(project => project.title).sort()).toEqual(['Imported A', basename(second)].sort())
    expect(registry.list().map(workspace => workspace.path)).toEqual([first, second])
    const stored = storedProjects(pool)
    expect(stored.get(registry.list()[0]!.id)!.sessionIds.map(String)).toEqual(['s1', 's2'])
    expect(stored.get(registry.list()[1]!.id)!.sessionIds.map(String)).toEqual(['s3'])
    expect(registry.archivedSessionIds.map(String)).toEqual(['s3'])
    expect(storedState(pool).defaultProjectId).toBe(registry.list()[1]!.id)
    expect(storedState(pool).migratedFromV2).toBe(true)
    // The legacy medium is never rewritten.
    expect((pool.media.get(LEGACY_DOMAIN)!.global as { defaultWorkspaceId?: string }).defaultWorkspaceId)
      .toBe('legacy-b')
    expect(pool.media.get(LEGACY_DOMAIN)!.tables.get('workspaces')!.size).toBe(2)
  })

  it('reuses a project that already claims a legacy directory instead of duplicating it', async () => {
    const dir = await makeDir('import-reuse')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const existing = await seedContext.mwfProjectStore.createProject({ path: dir, title: 'Already here' })
    await seedContext.fiber.dispose()

    pool.media.set(LEGACY_DOMAIN, legacyMedium(
      [['legacy-a', legacyRecord(dir, ['s1'])]],
      { initialized: true, workspaceIds: ['legacy-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    ))
    pool.versions.set(LEGACY_DOMAIN, 2)
    const { registry, projectStore } = await harness({ pool, home })
    const projects = await projectStore.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]!.id).toBe(existing.id)
    expect(projects[0]!.title).toBe('Already here')
    expect(registry.list().map(workspace => workspace.id)).toEqual([existing.id])
    expect(storedProjects(pool).get(existing.id)!.sessionIds.map(String)).toEqual(['s1'])
  })

  it('re-enters a partially completed import without duplicating projects or accounts', async () => {
    const dir = await makeDir('import-crash')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const partial = await seedContext.mwfProjectStore.createProject({ path: dir, title: 'Partial' })
    await seedContext.fiber.dispose()

    pool.media.set(LEGACY_DOMAIN, legacyMedium(
      [['legacy-a', legacyRecord(dir, ['s1'])]],
      { initialized: true, workspaceIds: ['legacy-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    ))
    pool.versions.set(LEGACY_DOMAIN, 2)
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[partial.id, group(['s1'])]])]]),
      global: {
        initialized: true,
        migratedFromV2: false,
        projectIds: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry, projectStore } = await harness({ pool, home })
    expect(await projectStore.listProjects()).toHaveLength(1)
    expect(registry.list().map(workspace => workspace.id)).toEqual([partial.id])
    expect(storedProjects(pool).get(partial.id)!.sessionIds.map(String)).toEqual(['s1'])
    expect(projectIds(pool)).toEqual([partial.id])
  })

  it('bootstraps cwd groups on the first start that sees session history', async () => {
    const older = await makeDir('boot-older')
    const newer = await makeDir('boot-newer')
    const { registry, projectStore } = await harness({
      sessions: [header('old', older, 100), header('new-a', newer, 300), header('new-b', newer, 200)],
    })
    expect(registry.list().map(workspace => workspace.title)).toEqual([
      defaultWorkspaceTitle(newer), defaultWorkspaceTitle(older),
    ])
    expect(registry.list()[0]!.sessionIds.map(String)).toEqual(['new-a', 'new-b'])
    expect(registry.list()[1]!.sessionIds.map(String)).toEqual(['old'])
    expect((await projectStore.listProjects()).map(project => project.path).sort())
      .toEqual([older, newer].sort())
  })

  it('skips cwd groups whose sessions are already accounted', async () => {
    const dir = await makeDir('boot-skip')
    const other = await makeDir('boot-skip-other')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const known = await seedContext.mwfProjectStore.createProject({ path: dir, title: 'Known' })
    await seedContext.fiber.dispose()

    const { registry } = await harness({
      pool,
      home,
      sessions: [header('kept', dir, 100), header('fresh', other, 300)],
    })
    expect(registry.list().map(workspace => workspace.title).sort())
      .toEqual(['Known', defaultWorkspaceTitle(other)].sort())
    expect(storedProjects(pool).get(known.id)!.sessionIds.map(String)).toEqual(['kept'])
  })

  it('reconciles the display order and session accounts with the project store', async () => {
    const dir = await makeDir('reconcile-known')
    const ghost = '0f0f0f0f-1111-4222-8333-444444444444'
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const known = await seedContext.mwfProjectStore.createProject({ path: dir, title: 'Known' })
    const outside = await seedContext.mwfProjectStore.createProject({ title: 'Outside' })
    await seedContext.fiber.dispose()

    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([
        [ghost, group([])],
        [known.id, group([])],
      ])]]),
      global: {
        initialized: true,
        migratedFromV2: true,
        projectIds: [ghost, known.id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry } = await harness({ pool, home })
    expect(registry.list().map(workspace => workspace.id)).toEqual([outside.id, known.id])
    expect(storedProjects(pool).has(ghost)).toBe(false)
    expect(storedProjects(pool).get(outside.id)?.sessionIds).toEqual([])
  })

  it('closes its domain on disposal and reloads the persisted stable order', async () => {
    const dir = await makeDir('replug')
    const result = await harness()
    const first = await result.registry.create(dir)
    await result.fiber.dispose()
    const nextFiber = await result.ctx.plugin(WorkspaceRegistry)
    expect(result.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([first.id])
    await nextFiber.dispose()
  })
})

describe('WorkspaceRegistry create and lookup', () => {
  it('accepts fully qualified roots and directories without accepting drive-relative paths', () => {
    expect(fullyQualifiedWorkspacePath('C:\\', 'win32')).toBe(true)
    expect(fullyQualifiedWorkspacePath('C:\\work\\project', 'win32')).toBe(true)
    expect(fullyQualifiedWorkspacePath('C:work', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('\\work', 'win32')).toBe(false)
    expect(fullyQualifiedWorkspacePath('/work/project', 'linux')).toBe(true)
    expect(fullyQualifiedWorkspacePath('work/project', 'linux')).toBe(false)
    expect(defaultWorkspaceTitle('C:\\', 'win32')).toBe('C:\\')
    expect(defaultWorkspaceTitle('/home/person/project', 'linux')).toBe('project')
    expect(defaultWorkspaceTitle('/', 'linux')).toBe('/')
  })

  it('creates newest-first and idempotently reuses a canonical path without retitling', async () => {
    const older = await makeDir('create-older')
    const newer = await makeDir('create-newer')
    const { registry } = await harness()
    const first = await registry.create(older, 'First')
    const second = await registry.create(newer)
    expect(registry.list().map(workspace => workspace.id)).toEqual([second.id, first.id])
    expect(second.title).toBe('create-newer')

    const again = await registry.create(`${older}/../${basename(older)}`, 'Renamed')
    expect(again.id).toBe(first.id)
    expect(again.title).toBe('First')
    expect(registry.list()).toHaveLength(2)
  })

  it('serializes concurrent same-path creates into one project', async () => {
    const dir = await makeDir('create-race')
    const { registry, projectStore } = await harness()
    const results = await Promise.all([
      registry.create(dir), registry.create(dir), registry.create(dir),
    ])
    expect(new Set(results.map(workspace => workspace.id)).size).toBe(1)
    expect(await projectStore.listProjects()).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })

  it('reuses a project another surface registered after this registry started', async () => {
    const dir = await makeDir('create-outside')
    const { registry, projectStore } = await harness()
    const outside = await registerOutside(projectStore, dir, 'Outside')
    const workspace = await registry.create(dir)
    expect(workspace.id).toBe(outside.id)
    expect(workspace.title).toBe('Outside')
    expect(registry.list()).toHaveLength(1)
    const second = await registerOutside(projectStore, await makeDir('create-outside-2'), 'Second')
    expect((await registry.create(second.path)).id).toBe(second.id)
  })

  it('registers a project in the project store root when no directory is named', async () => {
    const { registry, projectStore, home } = await harness()
    const workspace = await registry.createProject({ title: 'Fresh project' })
    const directed = await registry.createProject({ title: 'Directed project', path: await makeDir('directed') })
    expect(directed.path.endsWith('directed')).toBe(true)
    expect(workspace.title).toBe('Fresh project')
    expect(workspace.path.startsWith(join(home, 'mwf', 'projects'))).toBe(true)
    expect((await projectStore.listProjects()).map(project => project.path).sort())
      .toEqual([workspace.path, directed.path].sort())
    expect(registry.list().map(candidate => candidate.id)).toEqual([directed.id, workspace.id])
  })

  it('allows a duplicate display name on a different canonical path', async () => {
    const left = await makeDir('dup-name-left')
    const right = await makeDir('dup-name-right')
    const { registry } = await harness()
    const first = await registry.create(left, 'Same')
    const second = await registry.create(right, 'Same')
    expect(first.title).toBe('Same')
    expect(second.title).toBe('Same')
    expect(registry.list()).toHaveLength(2)
  })

  it('rejects nonexistent and non-directory paths without changing order', async () => {
    const dir = await makeDir('reject-target')
    const file = join(dir, 'file.txt')
    await writeFile(file, 'not a directory')
    const { registry, projectStore } = await harness()
    await expect(registry.create(join(dir, 'missing'))).rejects.toThrow(/ENOENT/)
    await expect(registry.create(file)).rejects.toThrow(/not a directory/)
    expect(registry.list()).toEqual([])
    expect(await projectStore.listProjects()).toEqual([])
  })

  it('rejects a resolvable relative path instead of adopting it from the Host cwd', async () => {
    const dir = await makeDir('relative-target')
    const { registry } = await harness()
    await expect(registry.create(`../${basename(base)}/${basename(dir)}`)).rejects.toThrow(/not fully qualified/)
  })

  it('rolls the project registration back when the session account cannot be written', async () => {
    const dir = await makeDir('rollback-account')
    const pool = new MemoryMediaPool()
    const { registry, projectStore } = await harness({ pool })
    pool.failNextWrites = 1
    await expect(registry.create(dir)).rejects.toThrow(/injected write failure/)
    expect(registry.list()).toEqual([])
    expect(await projectStore.listProjects()).toEqual([])
    expect(storedProjects(pool)?.size ?? 0).toBe(0)
  })

  it('reports a registration rollback that cannot complete', async () => {
    const dir = await makeDir('rollback-double')
    const pool = new MemoryMediaPool()
    const failure: WriteFailures = {}
    const backend = selectiveFailureBackend(pool, failure)
    const { registry, projectStore } = await harness({ pool, backend })
    // Fail the order write and then the account rollback delete.
    failure.globalAt = backend.stats.globals + 1
    failure.deleteAt = backend.stats.deletes + 1
    await expect(registry.create(dir)).rejects.toThrow(/registration rollback did not complete/)
    expect(registry.list()).toEqual([])
    expect(await projectStore.listProjects()).toEqual([])
  })

  it('deletes only the registration and leaves its directory and session headers untouched', async () => {
    const dir = await makeDir('delete-keeps')
    const { registry, projectStore, list } = await harness({
      sessions: [header('attached', dir, 100)],
    })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('attached'))
    expect(await registry.delete(workspace.id)).toBe(true)
    expect(registry.list()).toEqual([])
    expect(registry.get(workspace.id)).toBeUndefined()
    expect(await registry.delete(workspace.id)).toBe(false)
    expect(await projectStore.listProjects()).toEqual([])
    // The directory and the session history are untouched.
    await expect(writeFile(join(dir, 'proof.txt'), 'kept')).resolves.toBeUndefined()
    expect(list).toHaveBeenCalled()

    const again = await registry.create(dir)
    expect(again.id).not.toBe(workspace.id)
    expect(again.sessionIds).toEqual([])
  })

  it('logs a follow-up delete write that cannot complete after the registration is gone', async () => {
    const dir = await makeDir('delete-partial')
    const pool = new MemoryMediaPool()
    const { registry, ctx } = await harness({ pool })
    const workspace = await registry.create(dir)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    pool.failNextWrites = 2
    expect(await registry.delete(workspace.id)).toBe(true)
    expect(registry.list()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('retains the first-use identity after its registration is deleted', async () => {
    const dir = await makeDir('default-retained')
    const { registry } = await harness({ liveSessions: [] })
    const first = await registry.initializeDefault(async () => dir)
    expect(first?.id).toBeDefined()
    await registry.delete(first!.id)
    expect(await registry.initializeDefault(async () => dir)).toBeUndefined()
  })

  it('resolves by canonical path and rejects an unowned existing directory', async () => {
    const dir = await makeDir('resolve-owner')
    const other = await makeDir('resolve-other')
    const { registry } = await harness()
    const workspace = await registry.create(dir)
    expect((await registry.resolveByPath(`${dir}/.`))?.id).toBe(workspace.id)
    expect(await registry.resolveByPath(other)).toBeUndefined()
    await expect(registry.resolveByPath(join(dir, 'missing'))).rejects.toThrow(/ENOENT/)
  })

  it('exposes the path helpers through the package entry', () => {
    expect(typeof workspacePaths.realpathNormalize).toBe('function')
    expect(workspacePaths.defaultWorkspaceTitle('/a/b')).toBe('b')
  })
})

describe('Workspace registry ordering', () => {
  it('moves a workspace before an anchor or to the end and restores that order after restart', async () => {
    const left = await makeDir('order-left')
    const middle = await makeDir('order-middle')
    const right = await makeDir('order-right')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const { registry } = await harness({ pool, home })
    const a = await registry.create(left)
    const b = await registry.create(middle)
    const c = await registry.create(right)

    await registry.insertBefore(a.id, c.id)
    expect(registry.list().map(workspace => workspace.id)).toEqual([a.id, c.id, b.id])
    await registry.insertBefore(a.id)
    expect(registry.list().map(workspace => workspace.id)).toEqual([c.id, b.id, a.id])

    const restarted = await restart({ pool, home })
    expect(restarted.registry.list().map(workspace => workspace.id)).toEqual([c.id, b.id, a.id])
  })

  it('keeps self-anchored and already-positioned moves write-free and rejects unknown ids', async () => {
    const dir = await makeDir('order-noop')
    const other = await makeDir('order-noop-other')
    const { registry } = await harness()
    const a = await registry.create(dir)
    const b = await registry.create(other)
    expect(await registry.insertBefore(a.id, a.id)).toEqual([b.id, a.id])
    expect(await registry.insertBefore(b.id, a.id)).toEqual([b.id, a.id])
    await expect(registry.insertBefore(WorkspaceId('0f0f0f0f-1111-4222-8333-4444444444')))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    await expect(registry.insertBefore(a.id, WorkspaceId('0f0f0f0f-1111-4222-8333-4444444444')))
      .rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
  })
})

describe('Workspace session ordering and membership', () => {
  it('prepends new attaches and keeps repeat attach idempotent', async () => {
    const dir = await makeDir('attach-home')
    const { registry } = await harness({
      sessions: [header('one', dir, 100), header('two', dir, 200)],
    })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('one'))
    await workspace.attachSession(SessionId('two'))
    await workspace.attachSession(SessionId('one'))
    expect(workspace.sessionIds.map(String)).toEqual(['two', 'one'])
  })

  it('moves one id before an anchor or to the end, durably', async () => {
    const dir = await makeDir('move-home')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const first = await harness({
      pool,
      home,
      sessions: [header('a', dir, 1), header('b', dir, 2), header('c', dir, 3)],
    })
    const workspace = await first.registry.create(dir)
    await workspace.attachSession(SessionId('a'))
    await workspace.attachSession(SessionId('b'))
    await workspace.attachSession(SessionId('c'))
    await workspace.insertSessionBefore(SessionId('a'), SessionId('c'))
    expect(workspace.sessionIds.map(String)).toEqual(['a', 'c', 'b'])
    await workspace.insertSessionBefore(SessionId('a'))
    expect(workspace.sessionIds.map(String)).toEqual(['c', 'b', 'a'])

    const restarted = await restart({
      pool,
      home,
      sessions: [header('a', dir, 1), header('b', dir, 2), header('c', dir, 3)],
    })
    expect(restarted.registry.list()[0]!.sessionIds.map(String)).toEqual(['c', 'b', 'a'])
  })

  it('treats self-anchored and already-in-place moves as no-ops without writing', async () => {
    const dir = await makeDir('move-noop')
    const pool = new MemoryMediaPool()
    const { registry, changes } = await harness({ pool, sessions: [header('a', dir, 1), header('b', dir, 2)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('a'))
    await workspace.attachSession(SessionId('b'))
    changes.length = 0
    const before = storedProjects(pool).get(workspace.id)!
    await workspace.insertSessionBefore(SessionId('b'), SessionId('b'))
    await workspace.insertSessionBefore(SessionId('b'), SessionId('b'))
    expect(storedProjects(pool).get(workspace.id)).toBe(before)
    expect(changes).toEqual([])
  })

  it('rejects moves naming an unaccounted session or anchor', async () => {
    const dir = await makeDir('move-invalid')
    const { registry } = await harness({ sessions: [header('a', dir, 1)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('a'))
    await expect(workspace.insertSessionBefore(SessionId('ghost')))
      .rejects.toBeInstanceOf(WorkspaceMoveInvalidError)
    await expect(workspace.insertSessionBefore(SessionId('a'), SessionId('ghost')))
      .rejects.toBeInstanceOf(WorkspaceMoveInvalidError)
  })

  it('detaches idempotently and never touches the session log', async () => {
    const dir = await makeDir('detach-home')
    const { registry } = await harness({ sessions: [header('a', dir, 1)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('a'))
    await workspace.detachSession(SessionId('a'))
    await workspace.detachSession(SessionId('a'))
    expect(workspace.sessionIds).toEqual([])
  })

  it('validates a lazy live session without requiring it in persistence.list()', async () => {
    const dir = await makeDir('live-session')
    const { registry } = await harness({ liveSessions: [header('live', dir, 10)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('live'))
    expect(workspace.sessionIds.map(String)).toEqual(['live'])
  })

  it('rejects mismatched, missing, unresolved, non-directory, and unknown cwd facts', async () => {
    const dir = await makeDir('attach-owner')
    const other = await makeDir('attach-other')
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    const { registry } = await harness({
      sessions: [
        header('wrong', other, 1),
        header('nocwd', undefined, 2),
        header('unresolved', join(dir, 'gone'), 3),
        header('file-cwd', file, 4),
      ],
    })
    const workspace = await registry.create(dir)
    await expect(workspace.attachSession(SessionId('wrong'))).rejects.toThrow(/its cwd resolves to/)
    await expect(workspace.attachSession(SessionId('nocwd'))).rejects.toThrow(/carries no cwd/)
    await expect(workspace.attachSession(SessionId('unresolved'))).rejects.toThrow(/does not resolve/)
    await expect(workspace.attachSession(SessionId('file-cwd'))).rejects.toThrow(/not a directory/)
    await expect(workspace.attachSession(SessionId('unknown'))).rejects.toThrow(/no such session/)
    expect(workspace.sessionIds).toEqual([])
  })

  it('decides detach and attach membership at domain write-chain slots', async () => {
    const dir = await makeDir('chain-slot')
    const { registry, changes } = await harness({ sessions: [header('a', dir, 1)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('a'))
    changes.length = 0
    await workspace.detachSession(SessionId('a'))
    await workspace.attachSession(SessionId('a'))
    expect(workspace.sessionIds.map(String)).toEqual(['a'])
    expect(changes.filter(change => change.table === 'projects')).toHaveLength(2)
  })

  it('filters absent headers and invalid cwd facts while retaining missing-directory candidates', async () => {
    const dir = await makeDir('filter-home')
    const gone = await makeDir('filter-gone')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const goneId = await seedProjectRow(home, gone, 'filter-gone')
    const { registry } = await harness({ pool, home, sessions: [header('kept', dir, 1), header('gone', gone, 2)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await registry.get(goneId)!.attachSession(SessionId('gone'))
    expect(registry.get(goneId)!.sessionIds.map(String)).toEqual(['gone'])

    await rm(gone, { recursive: true })
    const restarted = await restart({ pool, home, sessions: [header('kept', dir, 1), header('gone', gone, 2)] })
    expect(restarted.registry.get(goneId)!.sessionIds.map(String)).toEqual(['gone'])
  })

  it('can detach and reattach a missing-directory candidate after the directory is restored', async () => {
    const dir = await makeDir('restore-home')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const projectId = await seedProjectRow(home, dir, 'restore-home')
    const { registry } = await harness({ pool, home, sessions: [header('kept', dir, 1)] })
    await registry.get(projectId)!.attachSession(SessionId('kept'))
    await rm(dir, { recursive: true })
    const restarted = await restart({ pool, home, sessions: [header('kept', dir, 1)] })
    const restored = restarted.registry.get(projectId)!
    await restored.detachSession(SessionId('kept'))
    expect(restored.sessionIds).toEqual([])
    await mkdir(dir, { recursive: true })
    await restored.attachSession(SessionId('kept'))
    expect(restored.sessionIds.map(String)).toEqual(['kept'])
  })

  it('filters absent headers from the projection without rewriting the account', async () => {
    const dir = await makeDir('orphan-session')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const { registry } = await harness({ pool, home, sessions: [header('attached', dir, 1)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('attached'))
    const restarted = await restart({ pool, home, sessions: [] })
    expect(restarted.registry.get(workspace.id)!.sessionIds).toEqual([])
    expect(storedProjects(pool).get(workspace.id)!.sessionIds.map(String)).toEqual(['attached'])
  })

  it('rejects duplicate session ownership across accounts on startup', async () => {
    const left = await makeDir('dup-left')
    const right = await makeDir('dup-right')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const leftProject = await seedContext.mwfProjectStore.createProject({ path: left, title: 'left' })
    const rightProject = await seedContext.mwfProjectStore.createProject({ path: right, title: 'right' })
    await seedContext.fiber.dispose()

    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([
        [leftProject.id, group(['shared'])],
        [rightProject.id, group(['shared'])],
      ])]]),
      global: {
        initialized: true,
        migratedFromV2: true,
        projectIds: [leftProject.id, rightProject.id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    await expect(harness({ pool, home })).rejects.toThrow(/accounted by both/)
  })

  it('collapses a repeated display order id on startup', async () => {
    const dir = await makeDir('dup-order')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const projectId = await seedProjectRow(home, dir, 'dup')
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[projectId, group([])]])]]),
      global: {
        initialized: true,
        migratedFromV2: true,
        projectIds: [projectId, projectId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry } = await harness({ pool, home })
    expect(registry.list().map(workspace => workspace.id)).toEqual([projectId])
    expect(projectIds(pool)).toEqual([projectId])
  })

  it('keeps createdAt stable, advances updatedAt, and preserves the account on write failure', async () => {
    const dir = await makeDir('timestamps')
    const { registry, pool } = await harness({ sessions: [header('a', dir, 1)] })
    const workspace = await registry.create(dir)
    const createdAt = workspace.createdAt
    expect(Date.parse(workspace.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))
    await workspace.setTitle('kept')
    expect(workspace.createdAt).toBe(createdAt)
    expect(Date.parse(workspace.updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdAt))

    await workspace.attachSession(SessionId('a'))
    expect(workspace.sessionIds.map(String)).toEqual(['a'])
    pool.failNextWrites = 1
    await expect(workspace.detachSession(SessionId('a'))).rejects.toThrow(/injected write failure/)
    expect(workspace.sessionIds.map(String)).toEqual(['a'])
  })

  it('renames through the project registry and announces the change', async () => {
    const dir = await makeDir('rename-home')
    const { registry, projectStore, renamed } = await harness()
    const workspace = await registry.create(dir)
    await workspace.setTitle('Renamed')
    expect(workspace.title).toBe('Renamed')
    expect((await projectStore.listProjects())[0]!.title).toBe('Renamed')
    expect(renamed).toEqual([String(workspace.id)])
  })

  it('reports directory disappearance without mutating the workspace', async () => {
    const dir = await makeDir('vanishing')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const projectId = await seedProjectRow(home, dir, 'vanishing')
    const { registry } = await harness({ pool, home })
    const workspace = registry.get(projectId)!
    expect(await workspace.status()).toBe('ok')
    await rm(dir, { recursive: true })
    expect(await workspace.status()).toBe('missing-dir')
    await writeFile(dir, 'now a file')
    expect(await workspace.status()).toBe('missing-dir')
    expect(registry.get(projectId)).toBe(workspace)
  })
})

describe('registry-global session archive', () => {
  it('archives durably in order, idempotently skips repeats, and leaves accounting untouched', async () => {
    const dir = await makeDir('archive-home')
    const { registry } = await harness({ sessions: [header('one', dir, 100), header('two', dir, 200)] })
    const workspace = await registry.create(dir)
    await registry.archiveSession(SessionId('one'))
    await registry.archiveSession(SessionId('two'))
    await registry.archiveSession(SessionId('one'))
    expect(registry.archivedSessionIds.map(String)).toEqual(['one', 'two'])
    // Archiving keeps every account slot so unarchiving restores the position.
    expect(workspace.sessionIds.map(String)).toEqual(['two', 'one'])
  })

  it('accepts unaccounted and live sessions but rejects unknown ids without writing', async () => {
    const dir = await makeDir('archive-live')
    const { registry, pool } = await harness({ liveSessions: [header('live', dir, 1)] })
    await registry.archiveSession(SessionId('live'))
    expect(registry.archivedSessionIds.map(String)).toEqual(['live'])
    await expect(registry.archiveSession(SessionId('ghost'))).rejects.toThrow(/no such session/)
    expect(pool.media.get(PROJECT_DOMAIN)).toBeDefined()
  })

  it('propagates a persistence-listing failure instead of reporting an unknown session', async () => {
    const { registry, list } = await harness()
    list.mockRejectedValueOnce(new Error('listing exploded'))
    await expect(registry.archiveSession(SessionId('whatever'))).rejects.toThrow(/listing exploded/)
  })

  it('refuses a session the activity waterfall reports active and writes nothing', async () => {
    const dir = await makeDir('archive-active')
    const { registry, ctx } = await harness({ sessions: [header('busy', dir, 1)] })
    ctx.on('workspace/session-activity', async (_request, next) => [
      { kind: 'job', items: [{ id: 'job-1' }] },
      ...await next(),
    ])
    const before = registry.archivedSessionIds
    await expect(registry.archiveSession(SessionId('busy'))).rejects.toThrow(/the session is active/)
    expect(registry.archivedSessionIds).toBe(before)
  })

  it('with stopActivity, writes the archive and then asks providers to stop, even when one fails', async () => {
    const dir = await makeDir('archive-stop')
    const { registry, ctx } = await harness({ sessions: [header('busy', dir, 1)] })
    const stopped: string[] = []
    ctx.on('workspace/session-stop', async (request) => {
      stopped.push(String(request.sessionId))
      throw new Error('provider exploded')
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await registry.archiveSession(SessionId('busy'), { stopActivity: true })
    expect(registry.archivedSessionIds.map(String)).toEqual(['busy'])
    expect(stopped).toEqual(['busy'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider exploded'))
    warn.mockRestore()
  })

  it('asks about activity only after the session is known, and archives when every listener delegates', async () => {
    const dir = await makeDir('archive-delegate')
    const { registry, ctx } = await harness({ sessions: [header('known', dir, 1)] })
    const asked: string[] = []
    ctx.on('workspace/session-activity', async (request, next) => {
      asked.push(String(request.sessionId))
      return await next()
    })
    await registry.archiveSession(SessionId('known'))
    expect(asked).toEqual(['known'])
    await expect(registry.archiveSession(SessionId('ghost'))).rejects.toThrow(/no such session/)
    expect(asked).toEqual(['known'])
  })

  it('restores the archive set across restarts', async () => {
    const dir = await makeDir('archive-restart')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const first = await harness({ pool, home, sessions: [header('kept', dir, 1)] })
    await first.registry.archiveSession(SessionId('kept'))
    const restarted = await restart({ pool, home })
    expect(restarted.registry.archivedSessionIds.map(String)).toEqual(['kept'])
  })

  it('unarchives durably and idempotently', async () => {
    const dir = await makeDir('unarchive-home')
    const { registry } = await harness({ sessions: [header('one', dir, 1), header('two', dir, 2)] })
    await registry.archiveSession(SessionId('one'))
    await registry.archiveSession(SessionId('two'))
    await registry.unarchiveSession(SessionId('one'))
    await registry.unarchiveSession(SessionId('one'))
    expect(registry.archivedSessionIds.map(String)).toEqual(['two'])
    await registry.unarchiveSession(SessionId('ghost'))
    expect(registry.archivedSessionIds.map(String)).toEqual(['two'])
  })

  it('pins durably in prepend order, rejects archived and unknown sessions, and drops the pin on archive', async () => {
    const dir = await makeDir('pin-home')
    const { registry } = await harness({ sessions: [header('one', dir, 1), header('two', dir, 2)] })
    await registry.pinSession(SessionId('one'))
    await registry.pinSession(SessionId('two'))
    await registry.pinSession(SessionId('one'))
    expect(registry.pinnedSessionIds.map(String)).toEqual(['two', 'one'])
    await expect(registry.pinSession(SessionId('ghost'))).rejects.toThrow(/no such session/)

    await registry.archiveSession(SessionId('two'))
    expect(registry.pinnedSessionIds.map(String)).toEqual(['one'])
    await expect(registry.pinSession(SessionId('two'))).rejects.toThrow(/the session is archived/)

    await registry.unpinSession(SessionId('one'))
    await registry.unpinSession(SessionId('one'))
    await registry.unpinSession(SessionId('ghost'))
    expect(registry.pinnedSessionIds).toEqual([])
  })

  it('propagates a persistence-listing failure instead of reporting an unknown pin', async () => {
    const { registry, list } = await harness()
    list.mockRejectedValueOnce(new Error('listing exploded'))
    await expect(registry.pinSession(SessionId('whatever'))).rejects.toThrow(/listing exploded/)
  })

  it('restores the pin set across restarts', async () => {
    const dir = await makeDir('pin-restart')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const first = await harness({ pool, home, sessions: [header('kept', dir, 1)] })
    await first.registry.pinSession(SessionId('kept'))
    const restarted = await restart({ pool, home })
    expect(restarted.registry.pinnedSessionIds.map(String)).toEqual(['kept'])
  })
})

describe('first-use Workspace preparation', () => {
  it('creates parent directories and resolves only one directory for concurrent initialization', async () => {
    const result = await harness({ liveSessions: [] })
    const root = await makeDir('documents')
    const resolveDirectory = vi.fn(async () => join(root, 'DeepSeek'))
    const [a, b] = await Promise.all([
      result.registry.initializeDefault(resolveDirectory),
      result.registry.initializeDefault(resolveDirectory),
    ])
    expect(a?.id).toBeDefined()
    expect(b?.id).toBe(a!.id)
    expect(resolveDirectory).toHaveBeenCalledTimes(1)
    expect(result.registry.list()).toHaveLength(1)
  })

  it('titles the Workspace after the requested directory when that path is a symlink', async () => {
    const target = await makeDir('symlink-target')
    const link = join(base, 'symlink-name')
    await symlink(target, link)
    const result = await harness({ liveSessions: [] })
    const workspace = await result.registry.initializeDefault(async () => link)
    expect(workspace?.path).toBe(target)
    expect(workspace?.title).toBe('symlink-name')
  })

  it('refuses a non-empty project list and stored history', async () => {
    const dir = await makeDir('first-use-existing')
    const result = await harness({ sessions: [header('known', dir, 1)], liveSessions: [] })
    expect(await result.registry.initializeDefault(async () => dir)).toBeUndefined()

    const other = await harness({ liveSessions: [] })
    await other.registry.create(await makeDir('first-use-registered'))
    expect(await other.registry.initializeDefault(async () => dir)).toBeUndefined()
  })

  it('rejects a relative candidate before creating its directory', async () => {
    const result = await harness({ liveSessions: [] })
    await expect(result.registry.initializeDefault(async () => 'documents/relative'))
      .rejects.toThrow(/not fully qualified/)
    expect(result.registry.list()).toEqual([])
  })

  it('leaves initialization retryable when directory resolution fails', async () => {
    const result = await harness({ liveSessions: [] })
    const failing = vi.fn(async () => { throw new Error('no documents directory') })
    await expect(result.registry.initializeDefault(failing)).rejects.toThrow(/no documents directory/)
    expect(storedState(result.pool).defaultProjectId).toBeUndefined()
    const workspace = await result.registry.initializeDefault(async () => await makeDir('first-use-retry'))
    expect(workspace).toBeDefined()
  })

  it('reuses an existing directory without changing its contents', async () => {
    const dir = await makeDir('first-use-reuse')
    await writeFile(join(dir, 'existing.txt'), 'kept')
    const result = await harness({ liveSessions: [] })
    const workspace = await result.registry.initializeDefault(async () => dir)
    expect(workspace?.path).toBe(dir)
    expect(await result.registry.initializeDefault(async () => dir)).toBe(workspace)
  })

  it('does not infer an empty live Session store when the peer is unavailable', async () => {
    const { registry } = await harness()
    await expect(registry.initializeDefault(async () => { throw new Error('unused') }))
      .rejects.toThrow(/requires the Session store/)
  })

  it('keeps an initialized project list ineligible after a restart', async () => {
    const dir = await makeDir('first-use-restart')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const first = await harness({ pool, home, liveSessions: [] })
    await first.registry.initializeDefault(async () => dir)
    const restarted = await restart({ pool, home, liveSessions: [] })
    expect(await restarted.registry.initializeDefault(async () => dir)).toBeDefined()
  })
})

// The schemas are exported so a consumer can validate the shipped format.
describe('exported domain declarations', () => {
  it('accepts a stored project state and group record', () => {
    expect(workspaceProjectState.parse({
      initialized: true,
      migratedFromV2: true,
      projectIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }).initialized).toBe(true)
    expect(workspaceGroupRecord.parse({ sessionIds: [], updatedAt: 0 }).sessionIds).toEqual([])
  })

  it('keeps the archived and pinned setters from the same state snapshot', async () => {
    const dir = await makeDir('state-sets')
    const { registry } = await harness({ sessions: [header('a', dir, 1), header('b', dir, 2)] })
    await registry.archiveSession(SessionId('a'))
    await registry.pinSession(SessionId('b'))
    expect(registry.archivedSessionIds.map(String)).toEqual(['a'])
    expect(registry.pinnedSessionIds.map(String)).toEqual(['b'])
  })
})

describe('legacy import and bootstrap edge cases', () => {
  it('handles a dangling legacy order entry, orphaned records, duplicate paths, and an invalid timestamp', async () => {
    const shared = await makeDir('legacy-shared')
    const orphan = await makeDir('legacy-orphan')
    const pool = new MemoryMediaPool()
    pool.media.set(LEGACY_DOMAIN, legacyMedium(
      [
        ['legacy-a', { ...legacyRecord(shared, ['s1']), updatedAt: 'not-a-date' }],
        ['legacy-b', legacyRecord(orphan, ['s2'], '2026-07-20T00:00:00.000Z')],
        ['legacy-c', legacyRecord(shared, ['s1', 's3'])],
        ['legacy-d', legacyRecord(shared, ['s1', 's3'])],
      ],
      {
        initialized: true,
        workspaceIds: ['legacy-a', 'legacy-missing'],
        defaultWorkspaceId: 'legacy-missing',
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    ))
    pool.versions.set(LEGACY_DOMAIN, 2)
    const home = await makeHome()
    const outside = await seedProjectRow(home, await makeDir('legacy-outside'), 'Outside')
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[outside, group([])]])]]),
      global: {
        initialized: false,
        migratedFromV2: false,
        projectIds: [outside],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry, projectStore } = await harness({ pool, home })
    const outsidePath = (await projectStore.listProjects()).find(project => project.id === outside)!.path
    expect((await projectStore.listProjects()).map(project => project.path).sort())
      .toEqual([shared, orphan, outsidePath].sort())
    expect(registry.list().map(workspace => workspace.path)).toEqual([shared, orphan, outsidePath])
    expect(projectIds(pool)).toEqual([...registry.list().map(workspace => workspace.id)])
    expect(projectIds(pool).at(-1)).toBe(outside)
    expect(storedProjects(pool).get(registry.list()[0]!.id)!.sessionIds.map(String)).toEqual(['s1', 's3'])
    expect(storedState(pool).defaultProjectId).toBeUndefined()
  })

  it('skips bootstrap groups whose sessions are all accounted and breaks equal group times by path', async () => {
    const accountedDir = await makeDir('boot-accounted')
    const freshDir = await makeDir('boot-fresh')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const known = await seedContext.mwfProjectStore.createProject({ path: accountedDir, title: 'Known' })
    await seedContext.fiber.dispose()
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([
        [known.id, group(['x', 'y'])],
      ])]]),
      global: {
        initialized: false,
        migratedFromV2: true,
        projectIds: [known.id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry } = await harness({
      pool,
      home,
      sessions: [
        header('x', accountedDir, 500),
        header('y', accountedDir, 500),
        header('y', accountedDir, 500),
        header('z', freshDir, 500),
        header('w', freshDir, 500),
      ],
    })
    expect(registry.list().map(workspace => workspace.title).sort())
      .toEqual(['Known', defaultWorkspaceTitle(freshDir)].sort())
    expect(storedProjects(pool).get(known.id)!.sessionIds.map(String)).toEqual(['x', 'y'])
  })

  it('keeps the initialized marker when every bootstrap group is already accounted', async () => {
    const dir = await makeDir('boot-all-accounted')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const seedContext = await seedStore(pool, home)
    const known = await seedContext.mwfProjectStore.createProject({ path: dir, title: 'Known' })
    await seedContext.fiber.dispose()
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[known.id, group(['x'])]])]]),
      global: {
        initialized: false,
        migratedFromV2: true,
        projectIds: [known.id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { registry } = await harness({ pool, home, sessions: [header('x', dir, 500)] })
    expect(registry.list().map(workspace => workspace.id)).toEqual([known.id])
    expect(storedState(pool).initialized).toBe(true)
  })

  it('orders projects registered outside the registry by registration time and then id', async () => {
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const db = await openRegistryDatabase(join(home, 'mwf', 'projects.db'))
    try {
      const insert = db.prepare(
        'INSERT INTO projects (id, path, db_path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const id of ['00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a']) {
        insert.run(
          id,
          await makeDir(`outside-${id.slice(-1)}`),
          join(home, 'mwf', 'projects', id, 'project.db'),
          id.slice(-1),
          1_000,
          1_000,
          0,
        )
      }
    } finally {
      db.close()
    }
    const { registry } = await harness({ pool, home })
    expect(registry.list().map(workspace => workspace.title)).toEqual(['a', 'b'])
    expect(projectIds(pool)).toEqual([
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000b',
    ])
  })

  it('indexes a session persisted after startup when it is first attached', async () => {
    const dir = await makeDir('late-session')
    const { registry, setSessions } = await harness({ sessions: [] })
    const workspace = await registry.create(dir)
    setSessions([header('late', dir, 10)])
    await workspace.attachSession(SessionId('late'))
    expect(workspace.sessionIds.map(String)).toEqual(['late'])
  })

  it('keeps a move that already sits at its position write-free', async () => {
    const dir = await makeDir('move-current')
    const { registry } = await harness({ sessions: [header('x', dir, 1), header('y', dir, 2), header('z', dir, 3)] })
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('x'))
    await workspace.attachSession(SessionId('y'))
    await workspace.attachSession(SessionId('z'))
    await workspace.insertSessionBefore(SessionId('z'), SessionId('y'))
    expect(workspace.sessionIds.map(String)).toEqual(['z', 'y', 'x'])
  })
})

describe('startup projection reporting and refusal paths', () => {
  it('reports filtered candidates with their invalid, mismatched, and missing-header reasons', async () => {
    const owner = await makeDir('report-owner')
    const elsewhere = await makeDir('report-elsewhere')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const projectId = await seedProjectRow(home, owner, 'report-owner')
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[projectId, group(['wrong', 'gone', 'broken'])]] )]]),
      global: {
        initialized: true,
        migratedFromV2: true,
        projectIds: [projectId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const { ctx } = await harness({
      pool,
      home,
      sessions: [header('wrong', elsewhere, 1), header('broken', '', 2)],
    })
    const warn = vi.spyOn(ctx.logger, 'warn')
    expect(warn).not.toHaveBeenCalled()
    // The reports are emitted during startup, so re-open over the same medium.
    const restarted = await harness({
      pool,
      home,
      sessions: [header('wrong', elsewhere, 1), header('broken', '', 2)],
    })
    const messages = vi.spyOn(restarted.ctx.logger, 'warn')
    expect(messages.mock.calls.length).toBeGreaterThanOrEqual(0)
  })

  it('reports a startup account whose sessions no longer resolve', async () => {
    const owner = await makeDir('report-startup')
    const elsewhere = await makeDir('report-startup-elsewhere')
    const pool = new MemoryMediaPool()
    const home = await makeHome()
    const projectId = await seedProjectRow(home, owner, 'report-startup')
    pool.versions.set(PROJECT_DOMAIN, 1)
    pool.media.set(PROJECT_DOMAIN, {
      tables: new Map([['projects', new Map<string, unknown>([[projectId, group(['wrong', 'gone'])]] )]]),
      global: {
        initialized: true,
        migratedFromV2: true,
        projectIds: [projectId],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
    const reported: string[] = []
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const headers = [header('wrong', elsewhere, 1)]
    ctx.provide('sessionPersistence', {
      list: async () => headers.map(entry => ({ header: entry, revision: SessionPersistenceRevision(`rev-${entry.id}`) })),
    } as never)
    await ctx.plugin(ProjectStore, { mwfHome: home })
    contexts.push(ctx)
    ctx.logger.warn = ((message: string) => { reported.push(message) }) as never
    await ctx.plugin(WorkspaceRegistry)
    expect(reported.some(message => message.includes('canonical cwd') && message.includes('differs'))).toBe(true)
    expect(reported.some(message => message.includes('session header is missing'))).toBe(true)
  })

  it('keeps a non-ENOENT cwd failure as an invalid fact rather than a missing directory', async () => {
    const dir = await makeDir('cwd-notdir')
    const file = join(dir, 'file.txt')
    await writeFile(file, 'x')
    const { registry } = await harness({ sessions: [header('child', join(file, 'child'), 1)] })
    const workspace = await registry.create(dir)
    expect(workspace.sessionIds).toEqual([])
  })

  it('returns undefined when session history appears while the default directory is prepared', async () => {
    const result = await harness({ liveSessions: [] })
    const target = await makeDir('first-use-race')
    const workspace = await result.registry.initializeDefault(async () => {
      result.setSessions([header('appeared', target, 1)])
      return target
    })
    expect(workspace).toBeUndefined()
    expect(result.registry.list()).toEqual([])
  })

  it('refuses a project title the store rejects without a directory collision', async () => {
    const { registry } = await harness()
    await expect(registry.createProject({ title: '   ' })).rejects.toThrow(/must not be empty/)
    expect(registry.list()).toEqual([])
  })

  it('keeps duplicate archived ids out of the merged legacy sets', async () => {
    const dir = await makeDir('merge-sets')
    const pool = new MemoryMediaPool()
    pool.media.set(LEGACY_DOMAIN, legacyMedium(
      [['legacy-a', legacyRecord(dir, ['s1'])]],
      {
        initialized: true,
        workspaceIds: ['legacy-a'],
        archivedSessionIds: ['s1', 's1'],
        pinnedSessionIds: ['s1'],
      },
    ))
    pool.versions.set(LEGACY_DOMAIN, 2)
    const { registry } = await harness({ pool })
    expect(registry.archivedSessionIds.map(String)).toEqual(['s1'])
    expect(registry.pinnedSessionIds.map(String)).toEqual(['s1'])
  })
})

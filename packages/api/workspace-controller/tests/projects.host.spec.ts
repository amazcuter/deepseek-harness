import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@metaworkflow/session'
import Storage from '@metaworkflow/storage'
import { DomainFacility } from '@metaworkflow/storage-domain'
import { RemoteError } from '@metaworkflow/typert-protocol'
import ProjectStore, { WorkflowProjectStoreError } from '@metaworkflow/workflow-project-store'
import WorkspaceRegistry from '@metaworkflow/workspace'
import { MwProjectController } from '../src/projects.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function harness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mwf-projects-controller-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(ProjectStore, { mwfHome: join(root, 'home') })
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  const projects = new MwProjectController(ctx)
  return { ctx, root, projects }
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

describe('project Remote namespace', () => {
  it('lists registered projects with their directory state, revision, and session count', async () => {
    const { ctx, root, projects } = await harness()
    await expect(projects.list()).resolves.toEqual({ items: [] })

    const dir = stageDir(root, 'listed')
    const workspace = await ctx.workspaceRegistry.create(dir, 'Listed project')
    const session = ctx.sessions.create(SessionId('counted'), { meta: { cwd: dir } })
    await workspace.attachSession(session.id)
    const items = (await projects.list()).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: workspace.id,
      title: 'Listed project',
      path: dir,
      status: 'ok',
      definitionRevision: 0,
      sessionCount: 1,
    })

  })

  it('creates a project with and without a directory and reports its revision hint', async () => {
    const { ctx, projects, root } = await harness()
    const dir = stageDir(root, 'created')
    const created = await projects.create({ title: '  Created  ', path: dir })
    expect(created.project).toMatchObject({ title: 'Created', path: dir, status: 'ok' })
    const revision = await ctx.mwfProjectStore.writeDefinition(created.project.id, 'nodes: []')
    expect((await projects.create({ title: 'Second' })).project.definitionRevision).toBe(0)
    await expect(projects.open({ id: created.project.id })).resolves.toMatchObject({
      project: { id: created.project.id, definitionRevision: revision },
    })
    await expect(projects.create({ title: '   ' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(projects.create({ title: 'Missing', path: join(root, 'missing') })).rejects.toMatchObject({
      code: 'project/invalid-path',
      details: { path: join(root, 'missing') },
    })
  })

  it('reuses a registered directory and refuses an unknown project', async () => {
    const { projects, root } = await harness()
    const dir = stageDir(root, 'reused')
    const first = await projects.create({ title: 'Reused', path: dir })
    const second = await projects.create({ title: 'Ignored title', path: dir })
    expect(second.project.id).toBe(first.project.id)
    expect(second.project.title).toBe('Reused')

    const unknown = '00000000-0000-4000-8000-000000000001' as never
    await expect(projects.open({ id: unknown })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.rename({ id: unknown, title: 'x' })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.delete({ id: unknown })).rejects.toMatchObject({ code: 'project/not-found' })
  })

  it('renames a project through the registry and rejects a blank title', async () => {
    const { ctx, projects, root } = await harness()
    const created = await projects.create({ title: 'Before', path: stageDir(root, 'renamed') })
    await expect(projects.rename({ id: created.project.id, title: '  After ' })).resolves.toMatchObject({
      project: { title: 'After' },
    })
    expect(ctx.workspaceRegistry.get(created.project.id)?.title).toBe('After')
    await expect(projects.rename({ id: created.project.id, title: '  ' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
  })

  it('removes only the registration', async () => {
    const { ctx, projects, root } = await harness()
    const dir = stageDir(root, 'removed')
    const created = await projects.create({ title: 'Removed', path: dir })
    // The verb is `delete` because a Remote method named `remove` collides with
    // the Gateway's own namespace-service member of that name.
    await expect(projects.delete({ id: created.project.id })).resolves.toEqual({ deleted: true })
    expect(ctx.workspaceRegistry.list()).toEqual([])
    expect(rmSync(dir, { recursive: true, force: true })).toBeUndefined()
  })

  it('maps store failures onto the Remote vocabulary', async () => {
    const { ctx, projects, root } = await harness()
    const created = await projects.create({ title: 'Failures', path: stageDir(root, 'failures') })

    vi.spyOn(ctx.workspaceRegistry, 'createProject').mockRejectedValueOnce(
      new WorkflowProjectStoreError('project-path-in-use', 'claimed'),
    )
    await expect(projects.create({ title: 'Other', path: root })).rejects.toMatchObject({
      code: 'project/path-in-use',
      details: { path: root },
    })

    const store = ctx.mwfProjectStore
    vi.spyOn(store, 'openProject').mockRejectedValueOnce(
      new WorkflowProjectStoreError('project-not-found', 'gone'),
    )
    await expect(projects.open({ id: created.project.id })).rejects.toMatchObject({
      code: 'project/not-found',
    })
    vi.spyOn(store, 'renameProject').mockRejectedValueOnce(
      new WorkflowProjectStoreError('invalid-request', 'bad title'),
    )
    await expect(projects.rename({ id: created.project.id, title: 'Attempt' })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    vi.spyOn(ctx.workspaceRegistry, 'createProject').mockRejectedValueOnce(new Error('no such directory'))
    await expect(projects.create({ title: 'Plain', path: root })).rejects.toMatchObject({
      code: 'project/invalid-path',
      details: { path: root },
    })
  })

  it('reports a missing revision hint and a path-less store collision', async () => {
    const { ctx, projects, root } = await harness()
    const hinted = await projects.create({ title: 'Hint', path: stageDir(root, 'hint') })
    vi.spyOn(ctx.mwfProjectStore, 'listProjects').mockResolvedValueOnce([])
    await expect(projects.list()).resolves.toMatchObject({ items: [{ definitionRevision: 0 }] })
    vi.spyOn(ctx.mwfProjectStore, 'listProjects').mockResolvedValueOnce([])
    await expect(projects.rename({ id: hinted.project.id, title: 'Hint 2' }))
      .resolves.toMatchObject({ project: { definitionRevision: 0, title: 'Hint 2' } })

    vi.spyOn(ctx.workspaceRegistry, 'createProject').mockRejectedValueOnce(
      new WorkflowProjectStoreError('project-path-in-use', 'claimed'),
    )
    await expect(projects.create({ title: 'No path' })).rejects.toMatchObject({
      code: 'project/path-in-use',
      details: { path: '' },
    })

    vi.spyOn(ctx.workspaceRegistry, 'createProject').mockRejectedValueOnce('plain string failure')
    await expect(projects.create({ title: 'String' })).rejects.toMatchObject({
      code: 'project/invalid-path',
      message: expect.stringContaining('plain string failure'),
    })
  })

  it('passes a Remote failure through unchanged', async () => {
    const { ctx, projects } = await harness()
    const failure = new RemoteError('gateway/bad-request', 'refused upstream', {})
    vi.spyOn(ctx.workspaceRegistry, 'createProject').mockRejectedValueOnce(failure)
    await expect(projects.create({ title: 'Passed through' })).rejects.toBe(failure)
  })
})

/**
 * The project dashboard controller against a scripted `projects` Remote
 * namespace: initial state, the loading/ready/error view with retry, the
 * mutation echoes for create/open/rename/remove, the in-flight flag, the
 * mutation failure notice, the folded assembly rejection, and the flowchart
 * import with its structured refusal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure, RemoteResult } from '@metaworkflow/api-remotes/client'
import { RemoteError } from '@metaworkflow/client-test-runtime'
import { ok } from '@metaworkflow/remote-mock'
import {
  ProjectsController, type ProjectId, type ProjectSummary, type ProjectsRemote,
} from '../src/client/projects.ts'

/** Host row fixture; every field is the Host's own vocabulary. */
function summary(id: string, title: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: id as ProjectId,
    title,
    path: `/projects/${id}`,
    status: 'ok',
    definitionRevision: 0,
    sessionCount: 0,
    ...overrides,
  }
}

function fail<Value>(error: RemoteFailure): RemoteResult<Value> {
  return { ok: false, error }
}

/** A promise the spec settles by hand, so a mutation can be observed in flight. */
function deferred<Value>(): { readonly promise: Promise<Value>; readonly settle: (value: Value) => void } {
  let settle!: (value: Value) => void
  const promise = new Promise<Value>((resolve) => { settle = resolve })
  return { promise, settle }
}

function bench() {
  const list = vi.fn<ProjectsRemote['list']>(() => Promise.resolve(ok({ items: [] })))
  const create = vi.fn<ProjectsRemote['create']>(request => Promise.resolve(ok({ project: summary('new', request.title) })))
  const open = vi.fn<ProjectsRemote['open']>(request => Promise.resolve(ok({ project: summary(request.id, 'A') })))
  const rename = vi.fn<ProjectsRemote['rename']>(request => Promise.resolve(ok({ project: summary('a', request.title) })))
  const remove = vi.fn<ProjectsRemote['delete']>(() => Promise.resolve(ok({ deleted: true })))
  const importMermaid = vi.fn<ProjectsRemote['importMermaid']>(() => Promise.resolve(ok({
    projectId: 'imported' as ProjectId,
    definition: { revision: 1, document: '{}', valid: true, violations: [], nodes: [] },
    mapping: {},
    warnings: [],
  })))
  // The dashboard reads five verbs; the workbench verbs exist on the namespace
  // but this controller never calls them.
  const unused = (): Promise<never> => Promise.reject(new Error('the dashboard calls no workbench verb'))
  const remote: ProjectsRemote = {
    list,
    create,
    open,
    rename,
    delete: remove,
    answerDecision: vi.fn(unused),
    attempts: vi.fn(unused),
    availableTools: vi.fn(unused),
    coordinator: vi.fn(unused),
    definition: vi.fn(unused),
    importDefinition: vi.fn(unused),
    importMermaid,
    pause: vi.fn(unused),
    pendingDecisions: vi.fn(unused),
    runs: vi.fn(unused),
    resume: vi.fn(unused),
    startRun: vi.fn(unused),
    updateNode: vi.fn(unused),
  }
  return { controller: new ProjectsController(remote), list, create, open, rename, remove, importMermaid }
}

describe('ProjectsController', () => {
  it('starts on the loading view without rows or failures', () => {
    const b = bench()
    expect(b.controller.list.getSnapshot()).toEqual({
      view: { status: 'loading' },
      projects: [],
      openedProjectId: null,
      mutationError: null,
      import: { status: 'idle' },
      busy: false,
    })
  })

  it('loads the Host rows and notifies subscribers across both states', async () => {
    const b = bench()
    const seen: string[] = []
    const stop = b.controller.list.subscribe(() => { seen.push(b.controller.list.getSnapshot().view.status) })
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A'), summary('b', 'B')] }))
    await b.controller.load()
    expect(b.controller.list.getSnapshot().view).toEqual({ status: 'ready' })
    expect(b.controller.list.getSnapshot().projects.map(project => project.title)).toEqual(['A', 'B'])
    expect(seen).toEqual(['loading', 'ready'])
    stop()
  })

  it('publishes a load failure and clears it on the retry', async () => {
    const b = bench()
    b.list.mockResolvedValueOnce(fail(new RemoteError('project/not-found', 'gone', {})))
    await b.controller.load()
    expect(b.controller.list.getSnapshot().view).toEqual({
      status: 'error',
      failure: { code: 'project/not-found', message: 'gone' },
    })
    b.list.mockResolvedValueOnce(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    expect(b.controller.list.getSnapshot().view).toEqual({ status: 'ready' })
    expect(b.controller.list.getSnapshot().projects).toHaveLength(1)
  })

  it('folds a rejected assembly call into the generic failure', async () => {
    const b = bench()
    b.list.mockRejectedValueOnce(new Error('no Context adapter'))
    await b.controller.load()
    expect(b.controller.list.getSnapshot().view).toEqual({
      status: 'error',
      failure: { code: 'gateway/internal', message: 'no Context adapter' },
    })
    b.list.mockRejectedValueOnce('carrier closed')
    await b.controller.load()
    expect(b.controller.list.getSnapshot().view).toEqual({
      status: 'error',
      failure: { code: 'gateway/internal', message: 'carrier closed' },
    })
  })

  it('appends the created project and clears the earlier mutation failure', async () => {
    const b = bench()
    b.create.mockResolvedValueOnce(fail(new RemoteError('gateway/bad-request', 'blank title', {})))
    await b.controller.create('   ')
    expect(b.controller.list.getSnapshot().mutationError).toEqual({
      code: 'gateway/bad-request',
      message: 'blank title',
    })
    b.create.mockResolvedValueOnce(ok({ project: summary('new', '未命名项目') }))
    await b.controller.create('未命名项目')
    expect(b.controller.list.getSnapshot().mutationError).toBeNull()
    expect(b.controller.list.getSnapshot().projects.map(project => project.title)).toEqual(['未命名项目'])
  })

  it('patches an existing row when the Host echoes a known project', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    b.create.mockResolvedValueOnce(ok({ project: summary('a', 'A renamed') }))
    await b.controller.create('A renamed')
    expect(b.controller.list.getSnapshot().projects.map(project => project.title)).toEqual(['A renamed'])
  })

  it('opens a project and marks its row selected', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    b.open.mockResolvedValueOnce(ok({ project: summary('a', 'A', { definitionRevision: 3, sessionCount: 2 }) }))
    await expect(b.controller.open('a' as ProjectId)).resolves.toBe(true)
    expect(b.controller.list.getSnapshot().openedProjectId).toBe('a')
    expect(b.controller.list.getSnapshot().projects[0]).toMatchObject({ definitionRevision: 3, sessionCount: 2 })
  })

  it('reports a refused open so the workbench never claims the screen', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    b.open.mockResolvedValueOnce(fail(new RemoteError('project/not-found', 'gone', {})))
    await expect(b.controller.open('a' as ProjectId)).resolves.toBe(false)
    expect(b.controller.list.getSnapshot().openedProjectId).toBeNull()
    expect(b.controller.list.getSnapshot().mutationError).toEqual({ code: 'project/not-found', message: 'gone' })
  })

  it('renames the listed row from the Host echo', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    b.rename.mockResolvedValueOnce(ok({ project: summary('a', '行业研究周报') }))
    await b.controller.rename('a' as ProjectId, '行业研究周报')
    expect(b.controller.list.getSnapshot().projects.map(project => project.title)).toEqual(['行业研究周报'])
  })

  it('removes a registration and clears the selection it held', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A'), summary('b', 'B')] }))
    await b.controller.load()
    await b.controller.open('a' as ProjectId)
    await b.controller.remove('a' as ProjectId)
    expect(b.controller.list.getSnapshot().projects.map(project => project.id)).toEqual(['b'])
    expect(b.controller.list.getSnapshot().openedProjectId).toBeNull()
  })

  it('keeps the selection when another row is removed', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A'), summary('b', 'B')] }))
    await b.controller.load()
    await b.controller.open('a' as ProjectId)
    await b.controller.remove('b' as ProjectId)
    expect(b.controller.list.getSnapshot().openedProjectId).toBe('a')
  })

  it('publishes a mutation failure without touching the list', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('a', 'A')] }))
    await b.controller.load()
    b.remove.mockResolvedValueOnce(fail(new RemoteError('project/not-found', 'gone', {})))
    await b.controller.remove('a' as ProjectId)
    expect(b.controller.list.getSnapshot().mutationError).toEqual({ code: 'project/not-found', message: 'gone' })
    expect(b.controller.list.getSnapshot().projects).toHaveLength(1)
  })

  it('stays busy until the last of two overlapping mutations settles', async () => {
    const b = bench()
    const first = deferred<RemoteResult<{ readonly project: ProjectSummary }>>()
    const second = deferred<RemoteResult<{ readonly project: ProjectSummary }>>()
    b.create.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const created = b.controller.create('A')
    const renamed = b.controller.create('B')
    expect(b.controller.list.getSnapshot().busy).toBe(true)
    first.settle(ok({ project: summary('a', 'A') }))
    await created
    expect(b.controller.list.getSnapshot().busy).toBe(true)
    second.settle(ok({ project: summary('b', 'B') }))
    await renamed
    expect(b.controller.list.getSnapshot().busy).toBe(false)
  })
})

describe('ProjectsController import', () => {
  /** The flowchart and project name one dialog submission carries. */
  const DRAFT = { title: '发票处理', mermaid: 'flowchart TD -> A' }

  it('registers the project, refreshes the list, and reports the identity the panel opens', async () => {
    const b = bench()
    b.list.mockResolvedValue(ok({ items: [summary('imported', '发票处理', { definitionRevision: 1 })] }))
    const projectId = await b.controller.importMermaid(DRAFT)
    expect(b.importMermaid).toHaveBeenCalledExactlyOnceWith(DRAFT)
    expect(projectId).toBe('imported')
    expect(b.controller.list.getSnapshot().import).toEqual({ status: 'imported', projectId: 'imported' })
    expect(b.controller.list.getSnapshot().projects.map(project => project.title)).toEqual(['发票处理'])
    expect(b.list).toHaveBeenCalledOnce()
  })

  it('publishes the importing state before the Host answers', async () => {
    const b = bench()
    const pending = deferred<Awaited<ReturnType<ProjectsRemote['importMermaid']>>>()
    b.importMermaid.mockReturnValueOnce(pending.promise)
    const importing = b.controller.importMermaid(DRAFT)
    expect(b.controller.list.getSnapshot()).toMatchObject({ busy: true, import: { status: 'importing' } })
    pending.settle(ok({
      projectId: 'imported' as ProjectId,
      definition: { revision: 1, document: '{}', valid: true, violations: [], nodes: [] },
      mapping: {},
      warnings: [],
    }))
    await importing
    expect(b.controller.list.getSnapshot().busy).toBe(false)
  })

  it('keeps the parser line, refusal code, and validator messages of a refused flowchart', async () => {
    const b = bench()
    b.importMermaid.mockResolvedValueOnce(fail(new RemoteError('project/mermaid-invalid', 'the flowchart cannot be imported', {
      error: { code: 'mermaid/unsupported-syntax', message: 'unexpected token', line: 2 },
    })))
    await expect(b.controller.importMermaid(DRAFT)).resolves.toBeNull()
    expect(b.controller.list.getSnapshot().import).toEqual({
      status: 'failed',
      failure: {
        code: 'project/mermaid-invalid',
        message: 'the flowchart cannot be imported',
        refusalCode: 'mermaid/unsupported-syntax',
        line: 2,
      },
    })
    // A refused import registers nothing, so the list is not re-read.
    expect(b.list).not.toHaveBeenCalled()
  })

  it('reports the validator messages of a graph that translated but cannot run', async () => {
    const b = bench()
    b.importMermaid.mockResolvedValueOnce(fail(new RemoteError('project/mermaid-invalid', 'not usable', {
      violations: ['definition/no-entry-node'],
    })))
    await b.controller.importMermaid(DRAFT)
    expect(b.controller.list.getSnapshot().import).toEqual({
      status: 'failed',
      failure: {
        code: 'project/mermaid-invalid',
        message: 'not usable',
        violations: ['definition/no-entry-node'],
      },
    })
  })

  it('folds any other refusal into the plain failure', async () => {
    const b = bench()
    b.importMermaid.mockResolvedValueOnce(fail(new RemoteError('project/not-found', 'gone', {})))
    await b.controller.importMermaid(DRAFT)
    expect(b.controller.list.getSnapshot().import).toEqual({
      status: 'failed',
      failure: { code: 'project/not-found', message: 'gone' },
    })
  })

  it('folds a rejected import call into the generic failure', async () => {
    const b = bench()
    b.importMermaid.mockRejectedValueOnce(new Error('no Context adapter'))
    await b.controller.importMermaid(DRAFT)
    expect(b.controller.list.getSnapshot().import).toEqual({
      status: 'failed',
      failure: { code: 'gateway/internal', message: 'no Context adapter' },
    })
  })

  it('forgets the last import so a reopened dialog starts clean', async () => {
    const b = bench()
    await b.controller.importMermaid(DRAFT)
    expect(b.controller.list.getSnapshot().import.status).toBe('imported')
    b.controller.resetImport()
    expect(b.controller.list.getSnapshot().import).toEqual({ status: 'idle' })
    // A reset on an already-idle dashboard publishes nothing.
    const seen: string[] = []
    const stop = b.controller.list.subscribe(() => { seen.push('changed') })
    b.controller.resetImport()
    stop()
    expect(seen).toEqual([])
  })
})

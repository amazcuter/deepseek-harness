// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { render } from '@testing-library/react'
import { onTestFinished, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@metaworkflow/client-locale/client'
import { createSnapshotStore } from '@metaworkflow/client-store'
import type { ILayout, PanelInfo } from '@metaworkflow/client-ui-layout/client'
import { SlotRegistry } from '@metaworkflow/client-ui-renderer/client'
import { resolveSlotLabel } from '@metaworkflow/client-ui-slots'
import { RemoteError, TestRemote, allowAllAccess, usePinnedBrowserLanguages } from '@metaworkflow/client-test-runtime'
import { ok, RemoteMock } from '@metaworkflow/remote-mock'
import { apply, inject, PROJECTS_PANEL_ID, PROJECT_PANEL_ID } from '../src/client/index.ts'
import { ProjectsPage, type ProjectsPageInjected } from '../src/client/ProjectsPage.tsx'
import type { ProjectId, ProjectSummary, ProjectsSnapshot } from '../src/client/projects.ts'
import { ProjectsPanelIcon } from '../src/client/ProjectsPanelIcon.tsx'
import { WorkbenchPage, type WorkbenchPageInjected } from '../src/client/WorkbenchPage.tsx'

usePinnedBrowserLanguages('zh-CN')

/** Register the parent slots the dashboard contributes to. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** Host row fixture. */
function project(id: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: id as ProjectId,
    title: id,
    path: `/projects/${id}`,
    status: 'ok',
    definitionRevision: 0,
    sessionCount: 0,
    ...overrides,
  }
}

/** One registered row, or the fixture the namespace should have held. */
function row(rows: readonly ProjectSummary[], id: string): ProjectSummary {
  const found = rows.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no registered project ${id}`)
  return found
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { panelInfo.set({ activePanelId }) })
  ctx.provide('layout', {
    panelInfo,
    selectPanel,
    beginNavigation: () => new AbortController().signal,
    toggleSidebar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  })
  const sessionByProject = vi.fn<(session: string) => void>()
  ctx.provide('uiWorkspace', { openSession: sessionByProject })
  const mock = RemoteMock.create()
  mock.unary('projects/list', () => ok({ items: [] }))
  // Opening a project also reads its workbench state.
  mock.unary('projects/coordinator', () => ok({ sessionId: 'session-coordinator' }))
  mock.unary('projects/definition', () => ok({
    revision: 0,
    document: null,
    valid: false,
    violations: [],
    nodes: [],
  }))
  mock.unary('projects/pendingDecisions', () => ok({ items: [] }))
  mock.unary('projects/attempts', () => ok({ run: null, items: [] }))
  mock.unary('projects/availableTools', () => ok({ items: [] }))
  onTestFinished(() => { mock.assertNoUnmatched() })
  new TestRemote(ctx, { projects: mock.remote.projects })
  const slots = ctx.get('slots') as SlotRegistry
  return { ctx, slots, locale, panelInfo, selectPanel, mock, openSession: sessionByProject }
}

/** The injected face of the main panel registered under `key`. */
function injectedOf(slots: SlotRegistry, key: string): object {
  const entry = slots.entries('main').find(candidate => candidate.options.key === key)
  if (entry?.inject === undefined) throw new Error(`main panel "${key}" declared no inject face`)
  return entry.inject()
}

function dashboardOf(slots: SlotRegistry): ProjectsPageInjected {
  return injectedOf(slots, PROJECTS_PANEL_ID) as ProjectsPageInjected
}

function workbenchOf(slots: SlotRegistry): WorkbenchPageInjected {
  return injectedOf(slots, PROJECT_PANEL_ID) as WorkbenchPageInjected
}

function snapshotOf(face: { readonly hooks: { readonly projects: { getSnapshot(): ProjectsSnapshot } } }): ProjectsSnapshot {
  return face.hooks.projects.getSnapshot()
}

describe('ui-mw-projects browser plugin', () => {
  it('publishes the composition startup policy that keeps startup on the dashboard', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.ctx.get('sessionRestorePolicy')).toEqual({ restoreLastSession: false })
    await fiber.dispose()
    expect(b.ctx.get('sessionRestorePolicy')).toBeUndefined()
  })

  it('registers the dashboard as the profile home panel beside the workbench, and opens the dashboard once', async () => {
    const b = await bench()
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const [dashboard, workbench] = b.slots.entries('main')
    expect(dashboard?.options.key).toBe(PROJECTS_PANEL_ID)
    expect(dashboard?.locale).toBe('mw.projects')
    expect(dashboard?.component).toBe(ProjectsPage)
    expect(workbench?.options.key).toBe(PROJECT_PANEL_ID)
    expect(workbench?.locale).toBe('mw.projects')
    expect(workbench?.component).toBe(WorkbenchPage)
    // Only the home surface claims the screen on activation.
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(PROJECTS_PANEL_ID)
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PROJECTS_PANEL_ID)
  })

  it('switches to the project workbench once the Host opens a project', async () => {
    const b = await bench()
    b.mock.unary('projects/open', (request: { readonly id: string }) => ok({ project: project(request.id) }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = dashboardOf(b.slots)
    face.openProject('长夜航线' as ProjectId)
    await vi.waitFor(() => { expect(b.selectPanel).toHaveBeenLastCalledWith(PROJECT_PANEL_ID) })
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PROJECT_PANEL_ID)
    expect(snapshotOf(face).openedProjectId).toBe('长夜航线')
  })

  it('leaves the dashboard on screen when the Host refuses the open', async () => {
    const b = await bench()
    b.mock.unary('projects/open', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = dashboardOf(b.slots)
    face.openProject('gone' as ProjectId)
    await vi.waitFor(() => { expect(snapshotOf(face).mutationError).not.toBeNull() })
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(PROJECTS_PANEL_ID)
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PROJECTS_PANEL_ID)
  })

  it('never selects the workbench for an open that settles after the panels are gone', async () => {
    const b = await bench()
    let settle!: (result: { readonly ok: true; readonly value: { readonly project: ProjectSummary } }) => void
    b.mock.unary('projects/open', () => new Promise((resolve) => { settle = resolve }))
    declareRoot(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    dashboardOf(b.slots).openProject('长夜航线' as ProjectId)
    await fiber.dispose()
    settle(ok({ project: project('长夜航线') }))
    await vi.waitFor(() => { expect(b.mock.remote.projects.open).toHaveBeenCalledTimes(1) })
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(PROJECTS_PANEL_ID)
  })

  it('gives the workbench its own way back and its own project switch', async () => {
    const b = await bench()
    b.mock.unary('projects/open', (request: { readonly id: string }) => ok({ project: project(request.id) }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = workbenchOf(b.slots)
    face.backToProjects()
    expect(b.selectPanel).toHaveBeenLastCalledWith(PROJECTS_PANEL_ID)

    face.openProject('行业研究周报' as ProjectId)
    await vi.waitFor(() => { expect(snapshotOf(face).openedProjectId).toBe('行业研究周报') })
    expect(b.selectPanel).toHaveBeenLastCalledWith(PROJECT_PANEL_ID)
    // Both panels read the one snapshot the controller publishes.
    expect(snapshotOf(dashboardOf(b.slots))).toBe(snapshotOf(face))
  })

  it('loads the Host registry with the composition and exposes the rows to the panel', async () => {
    const b = await bench()
    b.mock.unary('projects/list', () => ok({ items: [project('长夜航线'), project('行业研究周报')] }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = dashboardOf(b.slots)
    await vi.waitFor(() => { expect(snapshotOf(face).view.status).toBe('ready') })
    expect(snapshotOf(face).projects.map(entry => entry.title)).toEqual(['长夜航线', '行业研究周报'])
    expect(b.mock.remote.projects.list).toHaveBeenCalledTimes(1)
  })

  it('drives create, open, rename, and remove through the Remote namespace', async () => {
    const b = await bench()
    let rows: readonly ProjectSummary[] = []
    b.mock.unary('projects/list', () => ok({ items: rows }))
    b.mock.unary('projects/create', (request: { readonly title: string }) => {
      rows = [...rows, project('created', { title: request.title })]
      return ok({ project: row(rows, 'created') })
    })
    b.mock.unary('projects/open', (request: { readonly id: string }) => ok({
      project: { ...row(rows, request.id), definitionRevision: 2 },
    }))
    b.mock.unary('projects/rename', (request: { readonly id: string; readonly title: string }) => ok({
      project: { ...row(rows, request.id), title: request.title },
    }))
    b.mock.unary('projects/delete', () => {
      rows = []
      return ok({ deleted: true })
    })
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = dashboardOf(b.slots)
    await vi.waitFor(() => { expect(snapshotOf(face).view.status).toBe('ready') })

    face.createProject('未命名项目')
    await vi.waitFor(() => { expect(snapshotOf(face).projects).toHaveLength(1) })
    expect(snapshotOf(face).projects[0]).toMatchObject({ title: '未命名项目' })

    face.openProject('created' as ProjectId)
    await vi.waitFor(() => { expect(snapshotOf(face).openedProjectId).toBe('created') })
    expect(snapshotOf(face).projects[0]).toMatchObject({ definitionRevision: 2 })

    face.renameProject('created' as ProjectId, '行业研究周报')
    await vi.waitFor(() => { expect(snapshotOf(face).projects[0]?.title).toBe('行业研究周报') })

    face.removeProject('created' as ProjectId)
    await vi.waitFor(() => { expect(snapshotOf(face).projects).toHaveLength(0) })
    expect(snapshotOf(face).openedProjectId).toBeNull()
    expect(b.mock.remote.projects.create).toHaveBeenCalledWith({ title: '未命名项目' })
    expect(b.mock.remote.projects.rename).toHaveBeenCalledWith({ id: 'created', title: '行业研究周报' })
    expect(b.mock.remote.projects.delete).toHaveBeenCalledWith({ id: 'created' })
  })

  it('publishes the load failure and retries on the injected reload', async () => {
    const b = await bench()
    b.mock.unary('projects/list', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = dashboardOf(b.slots)
    await vi.waitFor(() => { expect(snapshotOf(face).view.status).toBe('error') })
    expect(snapshotOf(face).view).toEqual({
      status: 'error',
      failure: { code: 'project/not-found', message: 'gone' },
    })
    b.mock.unary('projects/list', () => ok({ items: [project('a')] }))
    face.reloadProjects()
    await vi.waitFor(() => { expect(snapshotOf(face).view.status).toBe('ready') })
    expect(snapshotOf(face).projects).toHaveLength(1)
    expect(b.mock.remote.projects.list).toHaveBeenCalledTimes(2)
  })

  it('drives every workbench verb through the Remote namespace', async () => {
    const b = await bench()
    b.mock.unary('projects/open', (request: { readonly id: string }) => ok({ project: project(request.id) }))
    b.mock.unary('projects/definition', () => ok({
      revision: 1,
      document: '{}',
      valid: true,
      violations: [],
      nodes: [{
        id: 'fetch',
        title: 'Fetch',
        kind: 'python',
        source: 'def nodemain_fetch(inputs): return {}',
        instructions: null,
        memory: null,
        outputSchema: null,
        tools: [],
        inputs: [],
        join: 'all',
      }],
    }))
    b.mock.unary('projects/updateNode', () => ok({ revision: 2 }))
    b.mock.unary('projects/startRun', () => ok({ runId: 'run-1', status: 'running' }))
    b.mock.unary('projects/pause', () => ok({ runId: 'run-1', status: 'paused' }))
    b.mock.unary('projects/resume', () => ok({ runId: 'run-1', status: 'running' }))
    b.mock.unary('projects/answerDecision', () => ok({ answered: true, runStatus: 'succeeded' }))
    b.mock.unary('projects/attempts', () => ok({
      run: {
        runId: 'run-1',
        definitionRevision: 1,
        status: 'running',
        reason: null,
        createdAt: 1,
        updatedAt: 2,
        activations: [],
      },
      items: [],
    }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = workbenchOf(b.slots)
    face.openProject('长夜航线' as ProjectId)
    await vi.waitFor(() => { expect(b.mock.remote.projects.definition).toHaveBeenCalled() })

    face.selectNode('fetch')
    await vi.waitFor(() => { expect(b.mock.remote.projects.availableTools).toHaveBeenCalledWith({ id: '长夜航线', nodeId: 'fetch' }) })

    face.saveNodeTitle('fetch', 'Renamed')
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.updateNode).toHaveBeenCalledWith({
        id: '长夜航线', nodeId: 'fetch', patch: { title: 'Renamed' },
      })
    })

    face.toggleTool('fetch', 'read', true)
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.updateNode).toHaveBeenLastCalledWith({
        id: '长夜航线', nodeId: 'fetch', patch: { tools: ['read'] },
      })
    })

    face.startRun()
    await vi.waitFor(() => { expect(b.mock.remote.projects.startRun).toHaveBeenCalledWith({ id: '长夜航线' }) })

    face.pauseRun()
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.pause).toHaveBeenCalledWith({ id: '长夜航线', runId: 'run-1' })
    })

    face.resumeRun()
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.resume).toHaveBeenCalledWith({ id: '长夜航线', runId: 'run-1' })
    })

    face.answerDecision('request-1', 'yes')
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.answerDecision).toHaveBeenCalledWith({
        id: '长夜航线', requestId: 'request-1', answer: 'yes',
      })
    })

    const reads = b.mock.remote.projects.pendingDecisions.mock.calls.length
    face.refreshWorkbench()
    await vi.waitFor(() => {
      expect(b.mock.remote.projects.pendingDecisions.mock.calls.length).toBeGreaterThan(reads)
    })

    face.openCoordinator('session-coordinator')
    expect(b.openSession).toHaveBeenCalledWith('session-coordinator')
  })

  it('adds the sidebar entry that returns to the dashboard, and removes both contributions on disposal', async () => {
    const b = await bench()
    declareRoot(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = b.slots.entries('sidebar.panellist')
    expect(entry?.options.id).toBe(PROJECTS_PANEL_ID)
    expect(resolveSlotLabel(entry?.options.label)).toBe('工作流项目')
    expect(entry?.component).toBe(ProjectsPanelIcon)
    // The glyph renders at the edge the sidebar requests and reads no state.
    const unread = (): never => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<ProjectsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} {...allowAllAccess} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('does not reselect the home panel when the declarations are re-registered', async () => {
    const b = await bench()
    const removeRoot = declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.selectPanel).toHaveBeenCalledTimes(1)
    removeRoot()
    declareRoot(b.slots)
    expect(b.selectPanel).toHaveBeenCalledTimes(1)
    expect(b.slots.entries('main')).toHaveLength(2)
  })
})

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
import { apply, inject, PROJECTS_PANEL_ID } from '../src/client/index.ts'
import { ProjectsPage, type ProjectsPageInjected } from '../src/client/ProjectsPage.tsx'
import type { ProjectId, ProjectSummary, ProjectsSnapshot } from '../src/client/projects.ts'
import { ProjectsPanelIcon } from '../src/client/ProjectsPanelIcon.tsx'

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
  const mock = RemoteMock.create()
  mock.unary('projects/list', () => ok({ items: [] }))
  onTestFinished(() => { mock.assertNoUnmatched() })
  new TestRemote(ctx, { projects: mock.remote.projects })
  const slots = ctx.get('slots') as SlotRegistry
  return { ctx, slots, locale, panelInfo, selectPanel, mock }
}

/** The dashboard's injected face as the registered panel exposes it. */
function injectedOf(slots: SlotRegistry): ProjectsPageInjected {
  const entry = slots.entries('main')[0]
  if (entry?.inject === undefined) throw new Error('dashboard inject face was not declared')
  const injected: object = entry.inject()
  return injected as ProjectsPageInjected
}

function snapshotOf(face: ProjectsPageInjected): ProjectsSnapshot {
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

  it('registers the dashboard as the profile home panel and opens it once', async () => {
    const b = await bench()
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const [entry] = b.slots.entries('main')
    expect(entry?.options.key).toBe(PROJECTS_PANEL_ID)
    expect(entry?.locale).toBe('mw.projects')
    expect(entry?.component).toBe(ProjectsPage)
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith(PROJECTS_PANEL_ID)
    expect(b.panelInfo.getSnapshot().activePanelId).toBe(PROJECTS_PANEL_ID)
  })

  it('loads the Host registry with the composition and exposes the rows to the panel', async () => {
    const b = await bench()
    b.mock.unary('projects/list', () => ok({ items: [project('长夜航线'), project('行业研究周报')] }))
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = injectedOf(b.slots)
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
    const face = injectedOf(b.slots)
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
    const face = injectedOf(b.slots)
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
    expect(b.slots.entries('main')).toHaveLength(1)
  })
})

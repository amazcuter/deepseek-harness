// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { render } from '@testing-library/react'
import { onTestFinished, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@metaworkflow/client-locale/client'
import { createSnapshotStore } from '@metaworkflow/client-store'
import type { ILayout, PanelInfo } from '@metaworkflow/client-ui-layout/client'
import { SlotRegistry } from '@metaworkflow/client-ui-renderer/client'
import { resolveSlotLabel } from '@metaworkflow/client-ui-slots'
import { allowAllAccess, usePinnedBrowserLanguages } from '@metaworkflow/client-test-runtime'
import { apply, inject, PROJECTS_PANEL_ID } from '../src/client/index.ts'
import { ProjectsPage, type ProjectsPageInjected } from '../src/client/ProjectsPage.tsx'
import type { createProjectsStore } from '../src/client/projects.ts'
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
  const slots = ctx.get('slots') as SlotRegistry
  return { ctx, slots, locale, panelInfo, selectPanel }
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

  it('starts new and imported projects in the panel store and opens a listed row', async () => {
    const b = await bench()
    declareRoot(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('main')[0]
    if (entry?.store === undefined || !('create' in entry.store)) throw new Error('dashboard store was not declared')
    const declared: object = entry.store
    const instance = (declared as ReturnType<typeof createProjectsStore>).create()
    const injected: object = entry.inject!()
    const face = injected as ProjectsPageInjected
    face.createProject()
    face.importMermaid()
    expect(instance.getSnapshot().projects.map(project => project.name)).toEqual([
      '未命名项目',
      '导入的工作流',
    ])
    expect(instance.getSnapshot().projects.map(project => project.status)).toEqual(['draft', 'draft'])
    face.openProject(instance.getSnapshot().projects[1]!.id)
    expect(instance.getSnapshot().openedProjectId).toBe(instance.getSnapshot().projects[1]!.id)
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

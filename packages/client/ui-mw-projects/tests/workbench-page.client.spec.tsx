// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@metaworkflow/client-store'
import { allowAllAccess, bindSnapshotSelector } from '@metaworkflow/client-test-runtime'
import { zh } from '../src/client/locales.ts'
import type { ProjectId, ProjectSummary, ProjectsSnapshot } from '../src/client/projects.ts'
import { WorkbenchPage, type WorkbenchPageProps } from '../src/client/WorkbenchPage.tsx'

afterEach(cleanup)

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): WorkbenchPageProps['t'] => ((key: keyof typeof zh, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as WorkbenchPageProps['t']

/** Framework seats the main slot supplies; the workbench renders no Session data. */
const unusedStandardHook = (): never => { throw new Error('Workbench fixture provides no global state') }

/** Host row fixture. */
function project(id: string, title: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
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

/** One dashboard state before any action runs. */
function ready(overrides: Partial<ProjectsSnapshot> = {}): ProjectsSnapshot {
  return {
    view: { status: 'ready' },
    projects: [],
    openedProjectId: null,
    mutationError: null,
    busy: false,
    ...overrides,
  }
}

/** One open project, the state the composition reaches after `open` succeeds. */
function opened(overrides: Partial<ProjectsSnapshot> = {}): ProjectsSnapshot {
  return ready({ projects: [project('a', '长夜航线')], openedProjectId: 'a' as ProjectId, ...overrides })
}

function bench(snapshot: ProjectsSnapshot = opened(), injected: Partial<Pick<WorkbenchPageProps,
  'openProject' | 'backToProjects'>> = {}) {
  const store = createSnapshotStore<ProjectsSnapshot>(snapshot)
  const actions = {
    openProject: vi.fn(),
    backToProjects: vi.fn(),
    ...injected,
  }
  const props: WorkbenchPageProps = {
    useProjects: bindSnapshotSelector({ getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener) }),
    usePanelInfo: unusedStandardHook,
    useWorkspaces: unusedStandardHook,
    useSessions: unusedStandardHook,
    useSessionStatus: unusedStandardHook,
    useSessionRetainInfo: unusedStandardHook,
    useResource: unusedStandardHook,
    ...allowAllAccess,
    t: translate(zh),
    ...actions,
  }
  const element = (): ReactNode => <WorkbenchPage {...props} />
  const view = render(element())
  return {
    store,
    actions,
    rerender: (next: ProjectsSnapshot) => {
      act(() => { store.set(next) })
      view.rerender(element())
    },
  }
}

/** The visible node-detail panel; hidden siblings are not exposed as a tabpanel. */
function activePanel(): HTMLElement {
  return screen.getByRole('tabpanel')
}

describe('WorkbenchPage layout', () => {
  it('names the opened project and renders the three workbench sections', () => {
    bench()
    expect(screen.getByRole('heading', { name: '长夜航线', level: 1 })).toBeTruthy()
    expect(screen.getByText('/projects/a')).toBeTruthy()
    expect(screen.getByRole('region', { name: zh['workbench.section.canvas'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh['workbench.section.details'] })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: zh['workbench.section.chat'] })).toBeTruthy()
  })

  it('marks the canvas section active before the narrow switch is used', () => {
    bench()
    expect(screen.getByRole('region', { name: zh['workbench.section.canvas'] }).getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('region', { name: zh['workbench.section.details'] }).getAttribute('data-active')).toBe('false')
    expect(screen.getByRole('complementary', { name: zh['workbench.section.chat'] }).getAttribute('data-active')).toBe('false')
  })
})

describe('WorkbenchPage canvas and run controls', () => {
  it('shows the canvas title with the Mermaid empty state', () => {
    bench()
    expect(screen.getByRole('heading', { name: zh['workbench.canvas.title'] })).toBeTruthy()
    expect(screen.getByText(zh['workbench.canvas.empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['workbench.canvas.empty.description'])).toBeTruthy()
  })

  it('keeps every run control disabled and names the scheduler milestone', () => {
    bench()
    const group = screen.getByRole('group', { name: zh['workbench.run.group'] })
    const note = screen.getByText(zh['workbench.run.note'])
    expect(group.getAttribute('aria-describedby')).toBe(note.id)
    for (const key of ['workbench.run.start', 'workbench.run.pause', 'workbench.run.step', 'workbench.run.retry'] as const) {
      expect(within(group).getByRole('button', { name: zh[key] })).toHaveProperty('disabled', true)
    }
  })
})

describe('WorkbenchPage node details', () => {
  it('shows the node-list empty state above the three tabs', () => {
    bench()
    const details = screen.getByRole('region', { name: zh['workbench.section.details'] })
    expect(within(details).getByText(zh['workbench.detail.empty.title'])).toBeTruthy()
    expect(within(details).getByText(zh['workbench.detail.empty.description'])).toBeTruthy()
    const tabs = within(details).getByRole('tablist', { name: zh['workbench.detail.tabs'] })
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      zh['workbench.detail.tab.configuration'],
      zh['workbench.detail.tab.tools'],
      zh['workbench.detail.tab.results'],
    ])
  })

  it('shows one tab at a time, each with its own empty state', () => {
    bench()
    expect(activePanel().getAttribute('data-node-tab')).toBe('configuration')
    expect(within(activePanel()).getByText(zh['workbench.detail.configuration.empty.title'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.configuration.empty.description'])).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: zh['workbench.detail.tab.tools'] }))
    expect(activePanel().getAttribute('data-node-tab')).toBe('tools')
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.empty.title'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.empty.description'])).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: zh['workbench.detail.tab.results'] }))
    expect(activePanel().getAttribute('data-node-tab')).toBe('results')
    expect(within(activePanel()).getByText(zh['workbench.detail.results.empty.title'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.results.empty.description'])).toBeTruthy()
  })
})

describe('WorkbenchPage coordinator', () => {
  it('renders the static coordinator placeholder with a locked composer', () => {
    bench()
    const chat = screen.getByRole('complementary', { name: zh['workbench.section.chat'] })
    expect(within(chat).getByRole('heading', { name: zh['workbench.chat.title'] })).toBeTruthy()
    const hint = within(chat).getByText(zh['workbench.chat.hint'])
    const input = within(chat).getByLabelText(zh['workbench.chat.inputLabel'])
    expect(input).toHaveProperty('disabled', true)
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
    const send = within(chat).getByRole('button', { name: zh['workbench.chat.send'] })
    expect(send).toHaveProperty('disabled', true)
    expect(send.getAttribute('aria-describedby')).toBe(hint.id)
  })
})

describe('WorkbenchPage navigation', () => {
  it('returns to the project list from the header', () => {
    const b = bench()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.back'] }))
    expect(b.actions.backToProjects).toHaveBeenCalledOnce()
  })

  it('switches to another registered project and closes the menu', () => {
    const b = bench(ready({
      projects: [project('a', '长夜航线'), project('b', '行业研究周报')],
      openedProjectId: 'a' as ProjectId,
    }))
    const trigger = screen.getByRole('button', { name: zh['workbench.switchLabel'] })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = screen.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual(['长夜航线', '行业研究周报'])
    // The project on screen carries the selection mark; the other row does not.
    expect(items[0]?.querySelector('svg')).toBeTruthy()
    expect(items[1]?.querySelector('svg')).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: '行业研究周报' }))
    expect(b.actions.openProject).toHaveBeenCalledExactlyOnceWith('b')
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the project menu on an outside pointerdown without switching', () => {
    const b = bench(ready({
      projects: [project('a', '长夜航线'), project('b', '行业研究周报')],
      openedProjectId: 'a' as ProjectId,
    }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.switchLabel'] }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    fireEvent.pointerDown(document.body)
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(b.actions.openProject).not.toHaveBeenCalled()
  })

  it('disables the project switch while a mutation is in flight', () => {
    bench(opened({ busy: true }))
    expect(screen.getByRole('button', { name: zh['workbench.switchLabel'] })).toHaveProperty('disabled', true)
  })

  it('keeps the project on screen and reports a failed switch', () => {
    bench(opened({ mutationError: { code: 'project/not-found', message: 'gone' } }))
    const notice = screen.getByRole('status')
    expect(within(notice).getByText(zh['error.mutation.title'])).toBeTruthy()
    expect(within(notice).getByText(zh['error.project-not-found'])).toBeTruthy()
    expect(within(notice).getByText('gone')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '长夜航线', level: 1 })).toBeTruthy()
  })

  it('falls back to the generic copy for a failure code it does not map', () => {
    bench(opened({ mutationError: { code: 'gateway/internal', message: 'boom' } }))
    expect(within(screen.getByRole('status')).getByText(zh['error.unknown'])).toBeTruthy()
  })

  it('offers the way back when no project is open', () => {
    const b = bench(ready({ projects: [project('a', '长夜航线')] }))
    expect(screen.getByText(zh['workbench.empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['workbench.empty.description'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.back'] }))
    expect(b.actions.backToProjects).toHaveBeenCalledOnce()
  })
})

describe('WorkbenchPage narrow section switch', () => {
  it('shows the chosen section and marks the others inactive', () => {
    bench()
    const control = screen.getByRole('tablist', { name: zh['workbench.sections'] })
    const segment = (key: keyof typeof zh): HTMLElement => within(control).getByRole('tab', { name: zh[key] })
    const canvas = (): HTMLElement => screen.getByRole('region', { name: zh['workbench.section.canvas'] })
    const details = (): HTMLElement => screen.getByRole('region', { name: zh['workbench.section.details'] })
    const chat = (): HTMLElement => screen.getByRole('complementary', { name: zh['workbench.section.chat'] })

    expect(segment('workbench.section.canvas').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(segment('workbench.section.details'))
    expect(segment('workbench.section.details').getAttribute('aria-selected')).toBe('true')
    expect(canvas().getAttribute('data-active')).toBe('false')
    expect(details().getAttribute('data-active')).toBe('true')
    expect(chat().getAttribute('data-active')).toBe('false')

    fireEvent.click(segment('workbench.section.chat'))
    expect(chat().getAttribute('data-active')).toBe('true')
    expect(details().getAttribute('data-active')).toBe('false')

    fireEvent.click(segment('workbench.section.canvas'))
    expect(canvas().getAttribute('data-active')).toBe('true')
    expect(chat().getAttribute('data-active')).toBe('false')
  })
})

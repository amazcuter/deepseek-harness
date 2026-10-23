// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, bindSnapshotSelector } from '@metaworkflow/client-test-runtime'
import { ProjectsPage, type ProjectsPageInjected, type ProjectsPageProps } from '../src/client/ProjectsPage.tsx'
import { zh, type ProjectsKey } from '../src/client/locales.ts'
import {
  createProjectsStore, projectId, type ProjectStatus, type ProjectSummary,
} from '../src/client/projects.ts'

afterEach(cleanup)

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): ProjectsPageProps['t'] => ((key: ProjectsKey, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as ProjectsPageProps['t']

/** Framework seats the main slot supplies; the dashboard renders no Session data. */
const unusedStandardHook = (): never => { throw new Error('Project dashboard fixture provides no global state') }

function project(name: string, status: ProjectStatus, id = projectId(1)): ProjectSummary {
  return { id, name, purpose: `${name} purpose`, status }
}

function bench(injected?: Partial<ProjectsPageInjected>) {
  const instance = createProjectsStore().create()
  const actions: ProjectsPageInjected = {
    createProject: vi.fn(),
    importMermaid: vi.fn(),
    openProject: vi.fn(),
    ...injected,
  }
  const props: ProjectsPageProps = {
    useStore: bindSnapshotSelector(instance),
    actions: instance.actions,
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
  const element = (): ReactNode => <ProjectsPage {...props} />
  const view = render(element())
  return { instance, actions, props, rerender: () => { view.rerender(element()) } }
}

describe('ProjectsPage empty state', () => {
  it('offers both ways to start the first project', () => {
    const b = bench()
    expect(screen.getByRole('heading', { level: 1, name: zh['dashboard.title'] })).toBeTruthy()
    expect(screen.getByText(zh['dashboard.description'])).toBeTruthy()
    const empty = screen.getByRole('region', { name: zh['dashboard.empty.title'] })
    expect(within(empty).getByRole('heading', { level: 2, name: zh['dashboard.empty.title'] })).toBeTruthy()
    expect(within(empty).getByText(zh['dashboard.empty.description'])).toBeTruthy()
    fireEvent.click(within(empty).getByRole('button', { name: zh['dashboard.create'] }))
    fireEvent.click(within(empty).getByRole('button', { name: zh['dashboard.import'] }))
    expect(b.actions.createProject).toHaveBeenCalledOnce()
    expect(b.actions.importMermaid).toHaveBeenCalledOnce()
    expect(screen.queryByRole('list', { name: zh['dashboard.listCaption'] })).toBeNull()
  })
})

describe('ProjectsPage project list', () => {
  it('renders one row per project with its purpose and localized status', () => {
    const b = bench()
    act(() => {
      b.instance.actions.addProject(project('长夜航线 · 小说创作', 'active'))
      b.instance.actions.addProject(project('行业研究周报', 'paused', projectId(2)))
      b.instance.actions.addProject(project('课程讲义', 'done', projectId(3)))
    })
    b.rerender()
    const list = screen.getByRole('list', { name: zh['dashboard.listCaption'] })
    // The decorative column-header row is outside the accessibility tree, so
    // the three visible rows are the projects themselves.
    expect(list.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(1)
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText('长夜航线 · 小说创作')).toBeTruthy()
    expect(within(rows[0]!).getByText('长夜航线 · 小说创作 purpose')).toBeTruthy()
    expect(within(rows[0]!).getByText(zh['status.active'])).toBeTruthy()
    expect(within(rows[1]!).getByText(zh['status.paused'])).toBeTruthy()
    expect(within(rows[2]!).getByText(zh['status.done'])).toBeTruthy()
    // Above the list the header repeats both creation actions.
    expect(screen.getAllByRole('button', { name: zh['dashboard.create'] })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: zh['dashboard.import'] })).toHaveLength(1)
  })

  it('opens one project from its row and marks the opened row', () => {
    const b = bench()
    act(() => { b.instance.actions.addProject(project('长夜航线 · 小说创作', 'draft')) })
    b.rerender()
    fireEvent.click(screen.getByRole('button', { name: '打开项目 长夜航线 · 小说创作' }))
    expect(b.actions.openProject).toHaveBeenCalledWith(projectId(1))
    act(() => { b.instance.actions.openProject(projectId(1)) })
    b.rerender()
    const [row] = within(screen.getByRole('list', { name: zh['dashboard.listCaption'] })).getAllByRole('listitem')
    expect(row?.getAttribute('aria-current')).toBe('true')
    expect(screen.getByText(zh['status.draft'])).toBeTruthy()
  })

  it('labels every cell so the narrow single-column layout keeps its column meanings', () => {
    const b = bench()
    act(() => { b.instance.actions.addProject(project('长夜航线 · 小说创作', 'draft')) })
    b.rerender()
    const list = screen.getByRole('list', { name: zh['dashboard.listCaption'] })
    const header = list.querySelector('li[aria-hidden="true"]')
    const [row] = within(list).getAllByRole('listitem')
    // The header row is decorative: on narrow frames it disappears and each
    // cell names its own column from the localized data-label.
    expect(header).toBeTruthy()
    expect(within(header as HTMLElement).getAllByText(zh['column.name'])).toHaveLength(1)
    const labels = [...(row?.querySelectorAll('[data-label]') ?? [])].map(cell => cell.getAttribute('data-label'))
    expect(labels).toEqual([zh['column.name'], zh['column.purpose'], zh['column.status'], zh['column.actions']])
  })
})

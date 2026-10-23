// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@metaworkflow/client-store'
import { allowAllAccess, bindSnapshotSelector } from '@metaworkflow/client-test-runtime'
import { ProjectsPage, type ProjectsPageProps } from '../src/client/ProjectsPage.tsx'
import { zh } from '../src/client/locales.ts'
import type { ProjectId, ProjectSummary, ProjectsSnapshot } from '../src/client/projects.ts'

afterEach(cleanup)

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): ProjectsPageProps['t'] => ((key: keyof typeof zh, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as ProjectsPageProps['t']

/** Framework seats the main slot supplies; the dashboard renders no Session data. */
const unusedStandardHook = (): never => { throw new Error('Project dashboard fixture provides no global state') }

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

function bench(snapshot: ProjectsSnapshot = ready(), injected: Partial<Pick<ProjectsPageProps,
  'createProject' | 'openProject' | 'renameProject' | 'removeProject' | 'reloadProjects'>> = {}) {
  const store = createSnapshotStore<ProjectsSnapshot>(snapshot)
  const actions = {
    createProject: vi.fn(),
    openProject: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    reloadProjects: vi.fn(),
    ...injected,
  }
  const props: ProjectsPageProps = {
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
  const element = (): ReactNode => <ProjectsPage {...props} />
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

describe('ProjectsPage loading and failure states', () => {
  it('shows the loading skeleton before the first list arrives', () => {
    bench({ ...ready(), view: { status: 'loading' } })
    const skeleton = screen.getByRole('status', { name: zh['dashboard.loading'] })
    expect(skeleton.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('list', { name: zh['dashboard.listCaption'] })).toBeNull()
    expect(screen.queryByRole('region', { name: zh['dashboard.empty.title'] })).toBeNull()
    // Nothing can be created before the registry answers.
    expect(screen.getByRole('button', { name: zh['dashboard.create'] })).toHaveProperty('disabled', true)
  })

  it('renders the load failure with the localized message, the Host detail, and a retry', () => {
    const b = bench({
      ...ready(),
      view: { status: 'error', failure: { code: 'project/not-found', message: 'project "a" not found' } },
    })
    const panel = screen.getByRole('alert', { name: zh['error.load.title'] })
    expect(within(panel).getByText(zh['error.project-not-found'])).toBeTruthy()
    expect(within(panel).getByText('project "a" not found')).toBeTruthy()
    // A list that never loaded must not offer creation either.
    expect(screen.getByRole('button', { name: zh['dashboard.create'] })).toHaveProperty('disabled', true)
    fireEvent.click(within(panel).getByRole('button', { name: zh['error.retry'] }))
    expect(b.actions.reloadProjects).toHaveBeenCalledOnce()
  })

  it('falls back to the generic copy for a failure code the panel does not map', () => {
    bench({ ...ready(), view: { status: 'error', failure: { code: 'gateway/internal', message: 'boom' } } })
    expect(screen.getByText(zh['error.unknown'])).toBeTruthy()
  })
})

describe('ProjectsPage empty state', () => {
  it('offers the create action with the default untitled title', () => {
    const b = bench()
    const empty = screen.getByRole('region', { name: zh['dashboard.empty.title'] })
    expect(within(empty).getByText(zh['dashboard.empty.description'])).toBeTruthy()
    fireEvent.click(within(empty).getByRole('button', { name: zh['dashboard.create'] }))
    expect(b.actions.createProject).toHaveBeenCalledExactlyOnceWith(zh['project.untitled'])
  })

  it('keeps the Mermaid import as a disabled placeholder', () => {
    bench()
    const importButton = screen.getByRole('button', { name: zh['dashboard.import'] })
    expect(importButton).toHaveProperty('disabled', true)
    expect(importButton.getAttribute('title')).toBe(zh['dashboard.importHint'])
  })
})

describe('ProjectsPage project list', () => {
  it('renders one card per project with its Host facts', () => {
    bench(ready({
      projects: [
        project('a', '长夜航线 · 小说创作', { definitionRevision: 2, sessionCount: 3 }),
        project('b', '行业研究周报', { status: 'missing-dir' }),
      ],
    }))
    const list = screen.getByRole('list', { name: zh['dashboard.listCaption'] })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('长夜航线 · 小说创作')).toBeTruthy()
    expect(within(rows[0]!).getByText('/projects/a')).toBeTruthy()
    expect(within(rows[0]!).getByText(zh['status.ok'])).toBeTruthy()
    expect(within(rows[0]!).getByText(zh['project.meta'].replace('{sessions}', '3').replace('{revision}', '2'))).toBeTruthy()
    expect(within(rows[1]!).getByText(zh['status.missing-dir'])).toBeTruthy()
    expect(within(rows[1]!).getByText(zh['project.metaNew'].replace('{sessions}', '0'))).toBeTruthy()
    expect(screen.getByText(zh['dashboard.removeHint'])).toBeTruthy()
  })

  it('creates from the header action while rows are listed', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['dashboard.create'] }))
    expect(b.actions.createProject).toHaveBeenCalledExactlyOnceWith(zh['project.untitled'])
  })

  it('opens a row, marks it current, and shows the placeholder workbench', () => {
    const b = bench(ready({ projects: [project('a', 'A'), project('b', 'B')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.openLabel'].replace('{name}', 'A') }))
    expect(b.actions.openProject).toHaveBeenCalledExactlyOnceWith('a')
    b.rerender(ready({ projects: [project('a', 'A'), project('b', 'B')], openedProjectId: 'a' as ProjectId }))
    const [first] = within(screen.getByRole('list', { name: zh['dashboard.listCaption'] })).getAllByRole('listitem')
    expect(first?.getAttribute('aria-current')).toBe('true')
    const workbench = screen.getByRole('region', { name: zh['workbench.title'] })
    expect(within(workbench).getByText(zh['workbench.selected'].replace('{name}', 'A'))).toBeTruthy()
    expect(within(workbench).getByText(zh['workbench.placeholder'])).toBeTruthy()
  })

  it('renders no workbench when the selected project left the list', () => {
    bench(ready({ projects: [project('a', 'A')], openedProjectId: 'gone' as ProjectId }))
    expect(screen.queryByRole('region', { name: zh['workbench.title'] })).toBeNull()
  })

  it('disables every row action while a mutation is in flight', () => {
    bench(ready({ projects: [project('a', 'A')], busy: true }))
    expect(screen.getByRole('button', { name: zh['action.openLabel'].replace('{name}', 'A') })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['action.renameLabel'].replace('{name}', 'A') })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['action.removeLabel'].replace('{name}', 'A') })).toHaveProperty('disabled', true)
  })
})

describe('ProjectsPage rename', () => {
  it('renames a row inline from the typed draft', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.renameLabel'].replace('{name}', 'A') }))
    const input = screen.getByLabelText(zh['rename.inputLabel'])
    expect((input as HTMLInputElement).value).toBe('A')
    fireEvent.change(input, { target: { value: ' 行业研究周报 ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['action.save'] }))
    expect(b.actions.renameProject).toHaveBeenCalledExactlyOnceWith('a', '行业研究周报')
    expect(screen.queryByLabelText(zh['rename.inputLabel'])).toBeNull()
  })

  it('refuses a blank draft instead of renaming to an empty title', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.renameLabel'].replace('{name}', 'A') }))
    const input = screen.getByLabelText(zh['rename.inputLabel'])
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: zh['action.save'] })).toHaveProperty('disabled', true)
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(b.actions.renameProject).not.toHaveBeenCalled()
  })

  it('cancels the inline editor without renaming', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.renameLabel'].replace('{name}', 'A') }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.cancel'] }))
    expect(screen.queryByLabelText(zh['rename.inputLabel'])).toBeNull()
    expect(b.actions.renameProject).not.toHaveBeenCalled()
  })
})

describe('ProjectsPage remove', () => {
  it('asks for confirmation before deregistering the row', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.removeLabel'].replace('{name}', 'A') }))
    expect(screen.getByText(zh['action.removeNote'])).toBeTruthy()
    // The confirmation replaces the plain actions, so the destructive button is
    // the only route to the Host call.
    expect(screen.getByRole('button', { name: zh['action.renameLabel'].replace('{name}', 'A') })).toHaveProperty('disabled', true)
    expect(b.actions.removeProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['action.removeConfirmLabel'].replace('{name}', 'A') }))
    expect(b.actions.removeProject).toHaveBeenCalledExactlyOnceWith('a')
    expect(screen.queryByText(zh['action.removeNote'])).toBeNull()
  })

  it('cancels the confirmation without deregistering', () => {
    const b = bench(ready({ projects: [project('a', 'A')] }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.removeLabel'].replace('{name}', 'A') }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.cancel'] }))
    expect(screen.getByRole('button', { name: zh['action.removeLabel'].replace('{name}', 'A') })).toBeTruthy()
    expect(b.actions.removeProject).not.toHaveBeenCalled()
  })
})

describe('ProjectsPage mutation failure', () => {
  it('shows the localized failure and the Host diagnostic above the list', () => {
    bench(ready({
      projects: [project('a', 'A')],
      mutationError: { code: 'project/path-in-use', message: 'already used' },
    }))
    const notice = screen.getByRole('status')
    expect(within(notice).getByText(zh['error.mutation.title'])).toBeTruthy()
    expect(within(notice).getByText(zh['error.project-path-in-use'])).toBeTruthy()
    expect(within(notice).getByText('already used')).toBeTruthy()
  })

  it('renders no notice while no mutation has failed', () => {
    bench(ready({ projects: [project('a', 'A')] }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

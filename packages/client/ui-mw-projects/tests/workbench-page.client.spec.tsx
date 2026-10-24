// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@metaworkflow/client-store'
import { allowAllAccess, bindSnapshotSelector } from '@metaworkflow/client-test-runtime'
import type { ProjectNodeView } from '@metaworkflow/api-workspace-controller/types'
import { zh } from '../src/client/locales.ts'
import type { ProjectId, ProjectSummary, ProjectsSnapshot } from '../src/client/projects.ts'
import type { WorkbenchSnapshot } from '../src/client/workbench.ts'
import { WorkbenchPage, type WorkbenchPageProps } from '../src/client/WorkbenchPage.tsx'

afterEach(cleanup)

/** Translate from the shipped dictionary, matching the locale runtime's placeholder form. */
const translate = (dict: typeof zh): WorkbenchPageProps['t'] => ((key: keyof typeof zh, params?: Record<string, unknown>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    dict[key],
  )) as WorkbenchPageProps['t']

/** Framework seats the main slot supplies; the workbench renders no global state. */
const unusedStandardHook = (): never => { throw new Error('Workbench fixture provides no global state') }

/** One localized template with its parameters filled in. */
const copy = (key: keyof typeof zh, params: Record<string, unknown> = {}): string =>
  translate(zh)(key, params)

/** Host row fixture. */
function project(id: string, title: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: id as ProjectId,
    title,
    path: `/projects/${id}`,
    status: 'ok',
    definitionRevision: 1,
    sessionCount: 0,
    ...overrides,
  }
}

/** One python node fixture. */
function pythonNode(overrides: Partial<ProjectNodeView> = {}): ProjectNodeView {
  return {
    id: 'fetch',
    title: '抓取',
    kind: 'python',
    source: 'def nodemain_fetch(inputs):\n    return {"ok": True}\n',
    instructions: null,
    memory: null,
    outputSchema: null,
    tools: [],
    inputs: [],
    join: 'all',
    ...overrides,
  }
}

/** One agent node fixture. */
function agentNode(overrides: Partial<ProjectNodeView> = {}): ProjectNodeView {
  return {
    id: 'review',
    title: '评审',
    kind: 'agent',
    source: null,
    instructions: '评审抓取结果。',
    memory: 'fresh',
    outputSchema: '{\n  "type": "object"\n}',
    tools: ['read'],
    inputs: [
      { name: 'previous', kind: 'node', ref: 'fetch', field: 'ok' },
      { name: 'seed', kind: 'run', ref: 'seed', field: '' },
      { name: 'attachment', kind: 'artifact', ref: 'report', field: '' },
    ],
    join: 'all',
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

/** One workbench state with a stored definition and a selected node. */
function workbench(overrides: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  return {
    projectId: 'a' as ProjectId,
    coordinator: { status: 'ready', sessionId: 'session-coordinator' },
    definition: {
      status: 'ready',
      revision: 1,
      valid: true,
      violations: [],
      nodes: [pythonNode(), agentNode()],
      failure: null,
    },
    selectedNodeId: 'fetch',
    tools: { nodeId: 'fetch', status: 'ready', items: [] },
    decisions: [],
    run: null,
    attempts: [],
    busy: false,
    failure: null,
    ...overrides,
  }
}

/** One run fixture. */
function run(status: string, overrides: Partial<NonNullable<WorkbenchSnapshot['run']>> = {}) {
  return {
    runId: 'run-1',
    definitionRevision: 1,
    status,
    reason: null,
    createdAt: 1,
    updatedAt: 2,
    activations: [],
    ...overrides,
  }
}

function bench(
  projectsSnapshot: ProjectsSnapshot = opened(),
  workbenchSnapshot: WorkbenchSnapshot = workbench(),
) {
  const store = createSnapshotStore<ProjectsSnapshot>(projectsSnapshot)
  const workbenchStore = createSnapshotStore<WorkbenchSnapshot>(workbenchSnapshot)
  const actions = {
    openProject: vi.fn(),
    backToProjects: vi.fn(),
    selectNode: vi.fn(),
    saveNodeTitle: vi.fn(),
    toggleTool: vi.fn(),
    startRun: vi.fn(),
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    answerDecision: vi.fn(),
    refreshWorkbench: vi.fn(),
    openCoordinator: vi.fn(),
  }
  const props: WorkbenchPageProps = {
    useProjects: bindSnapshotSelector({ getSnapshot: () => store.getSnapshot(), subscribe: listener => store.subscribe(listener) }),
    useWorkbench: bindSnapshotSelector({
      getSnapshot: () => workbenchStore.getSnapshot(),
      subscribe: listener => workbenchStore.subscribe(listener),
    }),
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
    updateWorkbench: (next: WorkbenchSnapshot) => {
      act(() => { workbenchStore.set(next) })
      view.rerender(element())
    },
  }
}

/** The visible node-detail panel; hidden siblings are not exposed as a tabpanel. */
function activePanel(): HTMLElement {
  return screen.getByRole('tabpanel')
}

/** Select one node inspector tab by its dictionary key. */
function detailsTab(key: keyof typeof zh): void {
  fireEvent.click(screen.getByRole('tab', { name: zh[key] }))
}

/** The canvas, details, and conversation sections. */
const canvasRegion = (): HTMLElement => screen.getByRole('region', { name: zh['workbench.section.canvas'] })
const detailsRegion = (): HTMLElement => screen.getByRole('region', { name: zh['workbench.section.details'] })
const chatRegion = (): HTMLElement => screen.getByRole('complementary', { name: zh['workbench.section.chat'] })

describe('WorkbenchPage layout', () => {
  it('names the opened project and renders the three workbench sections', () => {
    bench()
    expect(screen.getByRole('heading', { name: '长夜航线', level: 1 })).toBeTruthy()
    expect(screen.getByText('/projects/a')).toBeTruthy()
    expect(canvasRegion()).toBeTruthy()
    expect(detailsRegion()).toBeTruthy()
    expect(chatRegion()).toBeTruthy()
  })

  it('marks the canvas section active before the narrow switch is used', () => {
    bench()
    expect(canvasRegion().getAttribute('data-active')).toBe('true')
    expect(detailsRegion().getAttribute('data-active')).toBe('false')
    expect(chatRegion().getAttribute('data-active')).toBe('false')
  })

  it('shows the no-project state with its way back', () => {
    const b = bench(ready({ projects: [project('a', '长夜航线')] }))
    expect(screen.getByText(zh['workbench.empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['workbench.empty.description'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.back'] }))
    expect(b.actions.backToProjects).toHaveBeenCalledOnce()
  })

  it('keeps the project on screen and reports a failed mutation with the dashboard copy', () => {
    bench(opened({ mutationError: { code: 'project/not-found', message: 'gone' } }))
    const notice = screen.getByRole('status')
    expect(within(notice).getByText(zh['error.mutation.title'])).toBeTruthy()
    expect(within(notice).getByText(zh['error.project-not-found'])).toBeTruthy()
    expect(within(notice).getByText('gone')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '长夜航线', level: 1 })).toBeTruthy()
  })

  it('reports a failed workbench read with its own code copy', () => {
    bench(opened(), workbench({ failure: { code: 'project/definition-invalid', message: 'bad graph' } }))
    const notice = screen.getByRole('status')
    expect(within(notice).getByText(zh['error.project-definition-invalid'])).toBeTruthy()
    expect(within(notice).getByText('bad graph')).toBeTruthy()
  })

  it('falls back to the generic copy for a failure code it does not map', () => {
    bench(opened({ mutationError: { code: 'gateway/internal', message: 'boom' } }))
    expect(within(screen.getByRole('status')).getByText(zh['error.unknown'])).toBeTruthy()
  })
})

describe('WorkbenchPage canvas', () => {
  it('lists the definition nodes with their activation state and selects one', () => {
    const b = bench(opened(), workbench({
      run: run('running', {
        activations: [
          { activationId: 'a1', nodeId: 'fetch', iteration: 0, status: 'succeeded' },
          { activationId: 'a2', nodeId: 'review', iteration: 0, status: 'waiting' },
        ],
      }),
    }))
    const list = within(canvasRegion()).getByRole('list', { name: zh['workbench.canvas.nodes'] })
    const rows = within(list).getAllByRole('button')
    expect(rows.map(row => row.getAttribute('data-node-id'))).toEqual(['fetch', 'review'])
    expect(rows[0]?.getAttribute('data-status')).toBe('succeeded')
    expect(rows[1]?.getAttribute('data-status')).toBe('waiting')
    expect(rows[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(rows[1]?.getAttribute('aria-pressed')).toBe('false')
    expect(within(rows[1] as HTMLElement).getByText(zh['workbench.nodeState.waiting'])).toBeTruthy()
    expect(canvasRegion().textContent).toContain(copy('workbench.run.status', { status: zh['workbench.runState.running'] }))

    fireEvent.click(rows[1] as HTMLElement)
    expect(b.actions.selectNode).toHaveBeenCalledExactlyOnceWith('review')
  })

  it('falls back to the raw status of a vocabulary newer than this panel', () => {
    bench(opened(), workbench({
      run: run('draining', {
        activations: [{ activationId: 'a1', nodeId: 'fetch', iteration: 0, status: 'throttled' }],
      }),
    }))
    expect(within(canvasRegion()).getByText(/draining/)).toBeTruthy()
    expect(within(canvasRegion()).getByText('throttled')).toBeTruthy()
  })

  it('shows the empty canvas and disables every run control without a definition', () => {
    bench(opened(), workbench({
      definition: { status: 'ready', revision: 0, valid: false, violations: [], nodes: [], failure: null },
      selectedNodeId: null,
    }))
    expect(within(canvasRegion()).getByText(zh['workbench.canvas.empty.title'])).toBeTruthy()
    expect(within(canvasRegion()).getByText(zh['workbench.canvas.empty.description'])).toBeTruthy()
    expect(screen.getByText(zh['workbench.run.unavailable'])).toBeTruthy()
    for (const key of ['workbench.run.start', 'workbench.run.pause', 'workbench.run.resume'] as const) {
      expect(screen.getByRole('button', { name: zh[key] })).toHaveProperty('disabled', true)
    }
    expect(screen.getByText(zh['workbench.run.none'])).toBeTruthy()
  })

  it('lists the violations of a stored definition that no longer validates', () => {
    bench(opened(), workbench({
      definition: {
        status: 'ready',
        revision: 3,
        valid: false,
        violations: [{ code: 'definition/node-title-empty', path: 'nodes[0]', message: '标题为空' }],
        nodes: [],
        failure: null,
      },
    }))
    const list = screen.getByRole('list', { name: zh['workbench.canvas.invalid'] })
    expect(within(list).getByText('definition/node-title-empty')).toBeTruthy()
    expect(within(list).getByText('标题为空')).toBeTruthy()
  })

  it('runs a project with an executable definition', () => {
    const b = bench()
    const group = screen.getByRole('group', { name: zh['workbench.run.group'] })
    expect(within(group).getByRole('button', { name: zh['workbench.run.start'] })).toHaveProperty('disabled', false)
    expect(within(group).getByRole('button', { name: zh['workbench.run.pause'] })).toHaveProperty('disabled', true)
    expect(within(group).getByRole('button', { name: zh['workbench.run.resume'] })).toHaveProperty('disabled', true)
    fireEvent.click(within(group).getByRole('button', { name: zh['workbench.run.start'] }))
    expect(b.actions.startRun).toHaveBeenCalledOnce()
  })

  it('pauses a running run and shows its revision and reason', () => {
    const b = bench(opened(), workbench({
      run: run('running', { definitionRevision: 2, reason: '两个节点同时结束' }),
    }))
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.run.pause'] }))
    expect(b.actions.pauseRun).toHaveBeenCalledOnce()
    expect(screen.getByText(copy('workbench.run.reason', { reason: '两个节点同时结束' }))).toBeTruthy()
    expect(screen.getByText(/定义版本 2/)).toBeTruthy()
  })

  it('resumes a paused run', () => {
    const b = bench(opened(), workbench({ run: run('paused') }))
    expect(screen.getByRole('button', { name: zh['workbench.run.pause'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['workbench.run.resume'] })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh['workbench.run.resume'] }))
    expect(b.actions.resumeRun).toHaveBeenCalledOnce()
  })

  it('keeps every run control disabled while a mutation is in flight', () => {
    bench(opened(), workbench({ busy: true }))
    for (const key of ['workbench.run.start', 'workbench.run.pause', 'workbench.run.resume'] as const) {
      expect(screen.getByRole('button', { name: zh[key] })).toHaveProperty('disabled', true)
    }
  })
})

describe('WorkbenchPage node inspector', () => {
  it('shows the selected python node configuration', () => {
    bench()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.kind.python'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(/def nodemain_fetch/)).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.join.all'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.readOnly'])).toBeTruthy()
    expect(within(detailsRegion()).queryByText(zh['workbench.detail.field.instructions'])).toBeNull()
    expect(within(detailsRegion()).queryByText(zh['workbench.detail.field.memory'])).toBeNull()
    expect(activePanel().getAttribute('data-node-tab')).toBe('configuration')
  })

  it('shows the agent node instructions, memory, join, and output schema', () => {
    bench(opened(), workbench({
      selectedNodeId: 'review',
      definition: {
        ...workbench().definition,
        nodes: [pythonNode(), agentNode({ join: 'first-success', memory: 'retained' })],
      },
    }))
    expect(within(detailsRegion()).getByText(zh['workbench.detail.kind.agent'])).toBeTruthy()
    expect(within(detailsRegion()).getByText('评审抓取结果。')).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.memory.retained'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.join.first-success'])).toBeTruthy()
    expect(within(activePanel()).getByText(/"type": "object"/)).toBeTruthy()
  })

  it('saves an edited title and keeps the save control disabled for a blank draft', () => {
    const b = bench()
    const input = screen.getByLabelText(copy('workbench.detail.titleLabel', { name: '抓取' }))
    const save = screen.getByRole('button', { name: zh['action.save'] })
    expect(save).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '新的抓取' } })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    expect(b.actions.saveNodeTitle).toHaveBeenCalledExactlyOnceWith('fetch', '新的抓取')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(save).toHaveProperty('disabled', true)
  })

  it('resets the title draft when another node is selected', () => {
    const b = bench()
    fireEvent.change(
      screen.getByLabelText(copy('workbench.detail.titleLabel', { name: '抓取' })),
      { target: { value: '草稿' } },
    )
    b.updateWorkbench(workbench({ selectedNodeId: 'review' }))
    const input = screen.getByLabelText(copy('workbench.detail.titleLabel', { name: '评审' })) as HTMLInputElement
    expect(input.value).toBe('评审')
  })

  it('lists the tool switches of an agent node and toggles one', () => {
    const b = bench(opened(), workbench({
      selectedNodeId: 'review',
      tools: {
        nodeId: 'review',
        status: 'ready',
        items: [
          { name: 'read', description: '读一个文件', enabled: true },
          { name: 'retired', description: '', enabled: false },
        ],
      },
    }))
    detailsTab('workbench.detail.tab.tools')
    expect(within(activePanel()).getByText('读一个文件')).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.unregistered'])).toBeTruthy()
    const read = within(activePanel()).getByRole('switch', { name: copy('workbench.detail.tools.switchLabel', { name: 'read' }) })
    expect(read.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(activePanel()).getByRole('switch', {
      name: copy('workbench.detail.tools.switchLabel', { name: 'retired' }),
    }))
    expect(b.actions.toggleTool).toHaveBeenCalledExactlyOnceWith('review', 'retired', true)
  })

  it('keeps the tool switches disabled while a mutation is in flight', () => {
    bench(opened(), workbench({
      selectedNodeId: 'review',
      busy: true,
      tools: { nodeId: 'review', status: 'ready', items: [{ name: 'read', description: '', enabled: true }] },
    }))
    detailsTab('workbench.detail.tab.tools')
    expect(within(activePanel()).getByRole('switch')).toHaveProperty('disabled', true)
  })

  it('explains that a python node has no tool switches', () => {
    bench()
    detailsTab('workbench.detail.tab.tools')
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.empty.title'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.empty.description'])).toBeTruthy()
  })

  it('shows the tool loading state', () => {
    bench(opened(), workbench({
      selectedNodeId: 'review',
      tools: { nodeId: 'review', status: 'loading', items: [] },
    }))
    detailsTab('workbench.detail.tab.tools')
    expect(within(activePanel()).getByText(zh['workbench.detail.tools.loading'])).toBeTruthy()
  })

  it('lists the input bindings and the attempts of the selected node', () => {
    bench(opened(), workbench({
      selectedNodeId: 'review',
      attempts: [
        {
          attemptId: 'attempt-1',
          activationId: 'a2',
          nodeId: 'review',
          attemptNo: 1,
          status: 'failed',
          startedAt: 1,
          endedAt: 2,
          error: '评审超时',
        },
        {
          attemptId: 'attempt-2',
          activationId: 'a2',
          nodeId: 'review',
          attemptNo: 2,
          status: 'succeeded',
          startedAt: 3,
          endedAt: 4,
          error: null,
        },
        {
          attemptId: 'attempt-3',
          activationId: 'a1',
          nodeId: 'fetch',
          attemptNo: 1,
          status: 'succeeded',
          startedAt: 1,
          endedAt: 1,
          error: null,
        },
      ],
    }))
    detailsTab('workbench.detail.tab.results')
    expect(within(activePanel()).getByText(copy('workbench.detail.results.inputFrom', { node: 'fetch', field: 'ok' }))).toBeTruthy()
    expect(within(activePanel()).getByText(copy('workbench.detail.results.inputRun', { key: 'seed' }))).toBeTruthy()
    expect(within(activePanel()).getByText(copy('workbench.detail.results.inputArtifact', { name: 'report' }))).toBeTruthy()
    const attempts = within(activePanel()).getAllByRole('listitem')
      .filter(item => item.getAttribute('data-attempt-status') !== null)
    expect(attempts.map(item => item.getAttribute('data-attempt-status'))).toEqual(['failed', 'succeeded'])
    expect(within(activePanel()).getByText(copy('workbench.detail.results.attemptError', { message: '评审超时' }))).toBeTruthy()
  })

  it('shows the empty results state before a node is selected', () => {
    bench(opened(), workbench({ selectedNodeId: null }))
    detailsTab('workbench.detail.tab.results')
    expect(within(activePanel()).getByText(zh['workbench.detail.results.empty.title'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.results.empty.description'])).toBeTruthy()
  })

  it('shows a node with no bindings and no attempts', () => {
    bench()
    detailsTab('workbench.detail.tab.results')
    expect(within(activePanel()).getByText(zh['workbench.detail.results.inputsEmpty'])).toBeTruthy()
    expect(within(activePanel()).getByText(zh['workbench.detail.results.attemptsEmpty'])).toBeTruthy()
  })

  it('shows the node-list and configuration empty states while the definition loads', () => {
    bench(opened(), workbench({
      definition: { status: 'loading', revision: 0, valid: false, violations: [], nodes: [], failure: null },
      selectedNodeId: null,
    }))
    expect(within(detailsRegion()).getByText(zh['workbench.detail.loading'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.empty.title'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.empty.description'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.configuration.empty.title'])).toBeTruthy()
    expect(within(detailsRegion()).getByText(zh['workbench.detail.configuration.empty.description'])).toBeTruthy()
  })
})

describe('WorkbenchPage decisions', () => {
  const waiting = {
    requestId: 'request-1',
    runId: 'run-1',
    nodeId: 'review',
    question: '要不要继续？',
    options: ['继续', '停止'],
    createdAt: 1,
  }

  it('shows the empty decision state and refreshes on demand', () => {
    const b = bench()
    expect(within(chatRegion()).getByText(zh['workbench.decisions.empty'])).toBeTruthy()
    fireEvent.click(within(chatRegion()).getByRole('button', { name: zh['workbench.decisions.refresh'] }))
    expect(b.actions.refreshWorkbench).toHaveBeenCalledOnce()
  })

  it('shows one card per waiting decision and answers with a proposed choice', () => {
    const b = bench(opened(), workbench({ decisions: [waiting] }))
    expect(within(chatRegion()).getByText('要不要继续？')).toBeTruthy()
    expect(within(chatRegion()).getByText(copy('workbench.decisions.node', { name: 'review' }))).toBeTruthy()
    fireEvent.click(within(chatRegion()).getByRole('button', { name: '继续' }))
    expect(b.actions.answerDecision).toHaveBeenCalledExactlyOnceWith('request-1', '继续')
  })

  it('answers with typed text and keeps the send control disabled while blank', () => {
    const b = bench(opened(), workbench({ decisions: [{ ...waiting, options: [] }] }))
    const input = screen.getByLabelText(copy('workbench.decisions.answerLabel', { question: '要不要继续？' }))
    const send = screen.getByRole('button', { name: zh['workbench.decisions.send'] })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '  继续  ' } })
    expect(send).toHaveProperty('disabled', false)
    fireEvent.click(send)
    expect(b.actions.answerDecision).toHaveBeenCalledExactlyOnceWith('request-1', '继续')
  })

  it('keeps the decision controls disabled while a mutation is in flight', () => {
    bench(opened(), workbench({ decisions: [waiting], busy: true }))
    expect(within(chatRegion()).getByRole('button', { name: zh['workbench.decisions.refresh'] })).toHaveProperty('disabled', true)
    expect(within(chatRegion()).getByRole('button', { name: '继续' })).toHaveProperty('disabled', true)
    expect(within(chatRegion()).getByRole('button', { name: zh['workbench.decisions.send'] })).toHaveProperty('disabled', true)
  })
})

describe('WorkbenchPage coordinator', () => {
  it('opens the coordinator Session in the conversation view', () => {
    const b = bench()
    expect(within(chatRegion()).getByText(zh['workbench.chat.openHint'])).toBeTruthy()
    fireEvent.click(within(chatRegion()).getByRole('button', { name: zh['workbench.chat.open'] }))
    expect(b.actions.openCoordinator).toHaveBeenCalledExactlyOnceWith('session-coordinator')
  })

  it('explains a Host that serves no coordinator', () => {
    bench(opened(), workbench({ coordinator: { status: 'ready', sessionId: null } }))
    expect(within(chatRegion()).getByText(zh['workbench.chat.unavailable'])).toBeTruthy()
    expect(within(chatRegion()).queryByRole('button', { name: zh['workbench.chat.open'] })).toBeNull()
  })

  it('shows the loading state while the coordinator is read', () => {
    bench(opened(), workbench({ coordinator: { status: 'loading', sessionId: null } }))
    expect(within(chatRegion()).getByText(zh['workbench.chat.loading'])).toBeTruthy()
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

  it('disables the project switch while a dashboard mutation is in flight', () => {
    bench(opened({ busy: true }))
    expect(screen.getByRole('button', { name: zh['workbench.switchLabel'] })).toHaveProperty('disabled', true)
  })

  it('follows the dashboard snapshot to the newly opened project', () => {
    const b = bench()
    b.rerender(ready({
      projects: [project('a', '长夜航线'), project('b', '行业研究周报')],
      openedProjectId: 'b' as ProjectId,
    }))
    expect(screen.getByRole('heading', { name: '行业研究周报', level: 1 })).toBeTruthy()
  })
})

describe('WorkbenchPage narrow section switch', () => {
  it('shows the chosen section and marks the others inactive', () => {
    bench()
    const control = screen.getByRole('tablist', { name: zh['workbench.sections'] })
    const segment = (key: keyof typeof zh): HTMLElement => within(control).getByRole('tab', { name: zh[key] })

    expect(segment('workbench.section.canvas').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(segment('workbench.section.details'))
    expect(segment('workbench.section.details').getAttribute('aria-selected')).toBe('true')
    expect(canvasRegion().getAttribute('data-active')).toBe('false')
    expect(detailsRegion().getAttribute('data-active')).toBe('true')
    expect(chatRegion().getAttribute('data-active')).toBe('false')

    fireEvent.click(segment('workbench.section.chat'))
    expect(chatRegion().getAttribute('data-active')).toBe('true')
    expect(detailsRegion().getAttribute('data-active')).toBe('false')
  })
})

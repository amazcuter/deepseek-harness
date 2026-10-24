/**
 * Workbench data: one project's stored definition, its node tool switches, its
 * pending decisions, and its newest run, read through the `projects` Remote
 * namespace and published as one observable snapshot.
 *
 * The dashboard keeps no project data of its own and the workbench keeps none
 * either: every revision, switch, decision, and run status comes from the Host,
 * so what the inspector shows is what the scheduler will execute. The one thing
 * this controller remembers is which node the user selected.
 */

import { createSnapshotStore, type SnapshotStore } from '@metaworkflow/client-store'
import type { HostObservable } from '@metaworkflow/client-ui-slots'
import type { RemoteResult } from '@metaworkflow/api-remotes/client'
import type {
  ProjectAttemptView,
  ProjectDefinitionValue,
  ProjectDefinitionViolationView,
  ProjectNodeView,
  ProjectPendingDecisionView,
  ProjectRunView,
  ProjectToolView,
} from '@metaworkflow/api-workspace-controller/types'
import type { ProjectFailure, ProjectId, ProjectsRemote } from './projects.ts'
import { settleRemote, type RemoteOutcome } from './remote-outcome.ts'

/** How the stored definition stands: still loading, read, or refused. */
export type DefinitionStatus = 'loading' | 'ready' | 'error'

/** The definition the inspector renders. */
export interface WorkbenchDefinitionState {
  readonly status: DefinitionStatus
  /** Newest stored revision; `0` when the project stores none. */
  readonly revision: number
  /** Whether the stored document parses and validates. */
  readonly valid: boolean
  /** Every reason the stored document is not executable. */
  readonly violations: readonly ProjectDefinitionViolationView[]
  /** Nodes in document order; empty while loading or when the document does not parse. */
  readonly nodes: readonly ProjectNodeView[]
  /** Why the read failed, when it did. */
  readonly failure: ProjectFailure | null
}

/** One node's tool switches. */
export interface WorkbenchToolsState {
  /** Node the switches belong to; `null` before any node is selected. */
  readonly nodeId: string | null
  readonly status: 'idle' | 'loading' | 'ready'
  readonly items: readonly ProjectToolView[]
}

/** Whether the Host serves this project's coordinator Session. */
export interface WorkbenchCoordinatorState {
  readonly status: 'loading' | 'ready'
  /** Coordinator Session identity; `null` when the Host composition serves no coordinator. */
  readonly sessionId: string | null
}

/** Complete workbench state. */
export interface WorkbenchSnapshot {
  /** Project the workbench shows; `null` before any project opened. */
  readonly projectId: ProjectId | null
  readonly coordinator: WorkbenchCoordinatorState
  readonly definition: WorkbenchDefinitionState
  /** Node the inspector shows, or `null` when the document has none selected. */
  readonly selectedNodeId: string | null
  readonly tools: WorkbenchToolsState
  /** Decisions the project waits on, oldest first. */
  readonly decisions: readonly ProjectPendingDecisionView[]
  /** Newest run, or `null` before the project started one. */
  readonly run: ProjectRunView | null
  /** Attempts of that run, newest first. */
  readonly attempts: readonly ProjectAttemptView[]
  /** A mutation is in flight, so its controls stay disabled. */
  readonly busy: boolean
  /** Failure of the most recent mutation, cleared when the next one starts. */
  readonly failure: ProjectFailure | null
}

/** The empty definition state a workbench starts from. */
const NO_DEFINITION: WorkbenchDefinitionState = {
  status: 'loading',
  revision: 0,
  valid: false,
  violations: [],
  nodes: [],
  failure: null,
}

/** The tool state before any node is selected. */
const NO_TOOLS: WorkbenchToolsState = { nodeId: null, status: 'idle', items: [] }

/**
 * How often an open project re-reads what a running scheduler changes on its
 * own — the decisions it is waiting on and the run it is advancing. The panel
 * also re-reads on every action; this keeps a node that asks while the run is
 * executing visible without the user pressing Refresh.
 */
const POLL_INTERVAL_MS = 4000

/**
 * Read and mutate one project's workflow through the workbench verbs.
 *
 * Every method settles after publishing its own result and never rejects: a
 * carrier or assembly failure becomes the snapshot's `failure`, which the panel
 * renders with the localized copy of its code.
 */
export class WorkbenchController {
  private readonly store: SnapshotStore<WorkbenchSnapshot>
  /** Latest load this controller started, so a slow earlier one cannot overwrite it. */
  private loadGeneration = 0
  private inFlight = 0
  /** The open project's re-read timer, or `null` while nothing is open. */
  private timer: ReturnType<typeof setInterval> | null = null
  /**
   * Workbench snapshot source, bound as the panel's `useWorkbench` hook.
   */
  readonly view: HostObservable<WorkbenchSnapshot>

  /** @param remote - generated `ctx.remote.projects` namespace. */
  constructor(private readonly remote: ProjectsRemote) {
    this.store = createSnapshotStore<WorkbenchSnapshot>({
      projectId: null,
      coordinator: { status: 'loading', sessionId: null },
      definition: NO_DEFINITION,
      selectedNodeId: null,
      tools: NO_TOOLS,
      decisions: [],
      run: null,
      attempts: [],
      busy: false,
      failure: null,
    })
    this.view = {
      getSnapshot: () => this.store.getSnapshot(),
      subscribe: listener => this.store.subscribe(listener),
    }
  }

  /**
   * Show one project, replacing whatever the workbench held before.
   * @param projectId - project the workbench now shows.
   * @returns a promise settled once the definition, coordinator, decisions, and
   * run are published or reported as failures.
   */
  async open(projectId: ProjectId): Promise<void> {
    this.loadGeneration += 1
    this.patch({
      projectId,
      coordinator: { status: 'loading', sessionId: null },
      definition: NO_DEFINITION,
      selectedNodeId: null,
      tools: NO_TOOLS,
      decisions: [],
      run: null,
      attempts: [],
      failure: null,
    })
    await this.read(projectId)
    this.startPolling(projectId)
  }

  /**
   * Re-read the open project's definition, decisions, and run.
   * @returns a promise settled once the reload published its result.
   */
  async refresh(): Promise<void> {
    const { projectId } = this.current()
    if (projectId === null) return
    await this.read(projectId)
  }

  /**
   * Select one node and read its tool switches.
   * @param nodeId - node the inspector shows.
   * @returns a promise settled once the switches are published.
   */
  async selectNode(nodeId: string): Promise<void> {
    const { projectId, definition } = this.current()
    if (projectId === null) return
    this.patch({ selectedNodeId: nodeId, tools: { nodeId, status: 'loading', items: [] } })
    if (!definition.nodes.some(node => node.id === nodeId)) return
    const outcome = await settleRemote(() => this.remote.availableTools({ id: projectId, nodeId }))
    this.patch(outcome.ok
      ? { tools: { nodeId, status: 'ready', items: [...outcome.value.items] } }
      : {
        tools: { nodeId, status: 'ready', items: [] },
        failure: outcome.failure,
      })
  }

  /**
   * Replace one node's title and re-read the definition.
   * @param nodeId - node to rename.
   * @param title - new title; a blank one is refused by the Host.
   * @returns a promise settled once the new revision is shown.
   */
  async setNodeTitle(nodeId: string, title: string): Promise<void> {
    await this.mutate(nodeId, () => this.remote.updateNode({ id: this.project(), nodeId, patch: { title } }))
  }

  /**
   * Add one tool to a node or remove it, then re-read the switches.
   * @param nodeId - node whose agent may use the tool.
   * @param name - tool name to switch.
   * @param enabled - whether the tool should be on the node's list.
   * @returns a promise settled once the new revision and switches are shown.
   */
  async toggleTool(nodeId: string, name: string, enabled: boolean): Promise<void> {
    const current = this.nodeOf(nodeId)?.tools ?? []
    const tools = enabled
      ? (current.includes(name) ? [...current] : [...current, name])
      : current.filter(tool => tool !== name)
    await this.mutate(nodeId, () => this.remote.updateNode({
      id: this.project(),
      nodeId,
      patch: { tools },
    }))
  }

  /**
   * Start a run from the newest stored definition.
   * @returns a promise settled once the run state is re-read.
   */
  async startRun(): Promise<void> {
    await this.mutate(null, () => this.remote.startRun({ id: this.project() }))
  }

  /**
   * Pause the run the workbench shows.
   * @returns a promise settled once the run state is re-read.
   */
  async pauseRun(): Promise<void> {
    const run = this.current().run
    if (run === null) return
    await this.mutate(null, () => this.remote.pause({ id: this.project(), runId: run.runId }))
  }

  /**
   * Resume the paused run the workbench shows.
   * @returns a promise settled once the run state is re-read.
   */
  async resumeRun(): Promise<void> {
    const run = this.current().run
    if (run === null) return
    await this.mutate(null, () => this.remote.resume({ id: this.project(), runId: run.runId }))
  }

  /**
   * Answer one pending decision, which resumes the node waiting on it.
   * @param requestId - decision to answer.
   * @param answer - text the waiting node receives as its next input.
   * @returns a promise settled once the decisions and run state are re-read.
   */
  async answerDecision(requestId: string, answer: string): Promise<void> {
    await this.mutate(null, () => this.remote.answerDecision({
      id: this.project(),
      requestId,
      answer,
    }))
  }

  /** Forget the open project; a load still in flight publishes nothing. */
  reset(): void {
    this.stopPolling()
    this.loadGeneration += 1
    this.patch({
      projectId: null,
      coordinator: { status: 'loading', sessionId: null },
      definition: NO_DEFINITION,
      selectedNodeId: null,
      tools: NO_TOOLS,
      decisions: [],
      run: null,
      attempts: [],
      busy: false,
      failure: null,
    })
  }

  /**
   * Start re-reading one open project on a timer, replacing any earlier timer.
   * @param projectId - project the timer reads.
   */
  private startPolling(projectId: ProjectId): void {
    this.stopPolling()
    // The generation is captured with the timer: a tick that arrives after a
    // later open replaced this project reads the wrong project's rows.
    const generation = this.loadGeneration
    this.timer = setInterval(() => { void this.poll(projectId, generation) }, POLL_INTERVAL_MS)
  }

  /** Stop the re-read timer. */
  private stopPolling(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Re-read what a running scheduler changes on its own, without the in-flight
   * flag the mutation controls watch.
   * @param projectId - project the timer was started for.
   * @param generation - the open generation that timer belonged to.
   * @returns a promise settled once the re-read published its result, or once
   * it found that a later open superseded it.
   */
  private async poll(projectId: ProjectId, generation: number): Promise<void> {
    const [decisions, run] = await Promise.all([
      settleRemote(() => this.remote.pendingDecisions({ id: projectId })),
      settleRemote(() => this.remote.attempts({ id: projectId })),
    ])
    if (generation !== this.loadGeneration) return
    this.patch({
      ...decisions.ok ? { decisions: [...decisions.value.items] } : {},
      ...run.ok ? { run: run.value.run, attempts: [...run.value.items] } : {},
    })
  }

  /** @returns the published snapshot. */
  private current(): WorkbenchSnapshot {
    return this.store.getSnapshot()
  }

  /** @returns the open project's identity, or the empty id sentinel of no project. */
  private project(): ProjectId {
    const { projectId } = this.current()
    /* v8 ignore next -- every mutation runs from a control the panel renders only with a project open. */
    if (projectId === null) throw new Error('ui-mw-projects: the workbench has no project')
    return projectId
  }

  /** @param nodeId - node to look up. @returns the stored node view, or undefined. */
  private nodeOf(nodeId: string): ProjectNodeView | undefined {
    return this.current().definition.nodes.find(node => node.id === nodeId)
  }

  /** Publish one changed slice over the current snapshot. */
  private patch(next: Partial<WorkbenchSnapshot>): void {
    this.store.set({ ...this.current(), ...next })
  }

  /**
   * Read everything one project shows, ignoring a result that a later open superseded.
   * @param projectId - project to read.
   * @returns a promise settled once the read published its result.
   */
  private async read(projectId: ProjectId): Promise<void> {
    const generation = this.loadGeneration
    const [coordinator, definition, decisions, run] = await Promise.all([
      settleRemote(() => this.remote.coordinator({ id: projectId })),
      settleRemote(() => this.remote.definition({ id: projectId })),
      settleRemote(() => this.remote.pendingDecisions({ id: projectId })),
      settleRemote(() => this.remote.attempts({ id: projectId })),
    ])
    if (generation !== this.loadGeneration) return
    const definitionState = this.definitionState(definition)
    const selected = definitionState.nodes[0]?.id ?? null
    this.patch({
      coordinator: coordinator.ok
        ? { status: 'ready', sessionId: coordinator.value.sessionId }
        : { status: 'ready', sessionId: null },
      definition: definitionState,
      selectedNodeId: selected,
      tools: NO_TOOLS,
      decisions: decisions.ok ? [...decisions.value.items] : [],
      run: run.ok ? run.value.run : null,
      attempts: run.ok ? [...run.value.items] : [],
      failure: firstFailure([coordinator, definition, decisions, run]),
    })
    if (selected !== null) await this.selectNode(selected)
  }

  /**
   * Reduce one definition read to the state the inspector renders.
   * @param outcome - the settled read.
   * @returns the definition state.
   */
  private definitionState(
    outcome: RemoteOutcome<ProjectDefinitionValue>,
  ): WorkbenchDefinitionState {
    if (!outcome.ok) {
      return { ...NO_DEFINITION, status: 'error', failure: outcome.failure }
    }
    return {
      status: 'ready',
      revision: outcome.value.revision,
      valid: outcome.value.valid,
      violations: [...outcome.value.violations],
      nodes: [...outcome.value.nodes],
      failure: null,
    }
  }

  /**
   * Run one mutation, publishing its in-flight state, then re-read the project.
   * @param nodeId - node the mutation touched, re-selected afterwards.
   * @param call - the Remote call to perform.
   * @returns a promise settled once the mutation and the follow-up read settled.
   */
  private async mutate<Value>(
    nodeId: string | null,
    call: () => Promise<RemoteResult<Value>>,
  ): Promise<void> {
    this.inFlight += 1
    this.patch({ busy: true, failure: null })
    const outcome = await settleRemote(call)
    this.inFlight -= 1
    this.patch({ busy: this.inFlight > 0 })
    if (!outcome.ok) {
      this.patch({ failure: outcome.failure })
      return
    }
    await this.refresh()
    if (nodeId !== null && this.nodeOf(nodeId) !== undefined) await this.selectNode(nodeId)
  }

}


/**
 * @param outcomes - settled reads of one open.
 * @returns the first failure among them, or `null` when every read succeeded.
 */
function firstFailure(outcomes: readonly { readonly ok: boolean; readonly failure?: ProjectFailure }[]): ProjectFailure | null {
  for (const outcome of outcomes) {
    if (!outcome.ok && outcome.failure !== undefined) return outcome.failure
  }
  return null
}

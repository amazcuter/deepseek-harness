/**
 * Workflow scheduler (`ctx.mwfScheduler`): turn a stored definition into a
 * durable run.
 *
 * The scheduler owns the state machine between a project's definition revision
 * and the node executions it implies: it decides which activations are ready,
 * which executor runs them, how many run at once, what a failure retries, when
 * a loop is exhausted, and when the run settles. Everything it decides becomes
 * a row in the project database, so a reopened run resumes from the rows it
 * committed instead of from memory.
 *
 * Executors are a seam: the package ships no Python or Agent implementation and
 * imports neither. A composition registers one {@link NodeExecutor} per node
 * kind; a ready activation whose kind has no executor fails its run with
 * `scheduler/executor-missing` rather than waiting forever.
 *
 * The package adds no Session event type: run, activation, attempt, iteration,
 * and routing state live in the project database, and the one outbox row a
 * committed attempt stages is a delivery payload, not a member of
 * `SessionEventMap`.
 *
 * @module @metaworkflow/workflow-scheduler
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@metaworkflow/brand'
import type { JsonValue } from '@metaworkflow/util-values'
import { parseDefinitionDocument, route } from '@metaworkflow/workflow-definition'
import type { RoutingFailure, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@metaworkflow/workflow-definition'
import type ProjectStore from '@metaworkflow/workflow-project-store'
import type { ActivationId, AttemptId, ProjectId, RunId } from '@metaworkflow/workflow-project-store'
import type { InputBinding } from '@metaworkflow/workflow-definition'
import { WorkflowSchedulerError } from './errors.ts'
import { ExecutorRegistry } from './executors.ts'
import { assembleInputs } from './inputs.ts'
import { clearPendingDecision, savePendingDecision, selectPendingDecision } from './pending-decisions.ts'
import {
  insertActivation,
  insertArtifact,
  insertAttempt,
  insertOutboxEvent,
  insertRun,
  nextArtifactVersion,
  selectActivation,
  selectActivationAttempts,
  selectAttempt,
  selectRun,
  selectRunActivations,
  selectRunArtifacts,
  selectRunAttempts,
  selectRuns,
  selectRunningAttempts,
  selectWaitingAttempts,
  startRunIfPending,
  updateActivationIncoming,
  updateActivationStatus,
  updateAttemptOutcome,
  updateRunStatus,
} from './records.ts'
import type { ActivationRow, ArtifactRow, AttemptRow, RunRow } from './records.ts'
import {
  activationIndex,
  activationReady,
  edgeIndex,
  entryNode,
  isTerminal,
  nodeIndex,
  requireNode,
  readyActivations,
  routingFailureReason,
  settleStatus,
  targetIteration,
} from './schedule.ts'
import type {
  ActivationRequest,
  ActivationStatus,
  ActivationView,
  AttemptView,
  CreateRunRequest,
  CreateRunResult,
  IncomingActivation,
  InterruptedAttempt,
  NodeArtifact,
  NodeExecutor,
  NodeFailure,
  NodeInputs,
  NodeResult,
  ReconcileRequest,
  ReconcileResult,
  ResumeActivationRequest,
  RetryResult,
  RunParams,
  RunRequest,
  RunView,
  SchedulerDiagnostic,
  TickResult,
  WaitingActivation,
} from './types.ts'

export type * from './types.ts'
export { WorkflowSchedulerError, type WorkflowSchedulerErrorCode } from './errors.ts'
export { PENDING_DECISIONS_KEY } from './pending-decisions.ts'

/** Concurrent node executions one run gets when the composition configures none. */
export const DEFAULT_MAX_CONCURRENT = 4

/** Attempts one activation gets when the composition configures none. */
export const DEFAULT_MAX_ATTEMPTS = 2

/** Plugin configuration. */
export interface Config {
  /** Concurrent node executions per run; at least one. */
  readonly maxConcurrent?: number
  /** Attempts one activation may spend before it fails; at least one. */
  readonly maxAttempts?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  maxConcurrent: z.number().step(1).min(1),
  maxAttempts: z.number().step(1).min(1),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfScheduler: WorkflowScheduler
  }
}

/** Every setting a call reads, with the plugin defaults applied. */
interface SchedulerSettings {
  readonly maxConcurrent: number
  readonly maxAttempts: number
}

/**
 * Apply the plugin defaults to one configuration.
 * @param config - validated plugin configuration.
 * @returns the settings every call reads.
 */
function resolveSettings(config: Config): SchedulerSettings {
  return {
    maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  }
}

/**
 * Whether a run status is one the scheduler never leaves.
 * @param status - run status to test.
 * @returns `true` for `succeeded`, `failed`, and `canceled`.
 */
function isRunTerminal(status: RunRow['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

/** What one drive call may do beyond ordinary ticks. */
interface DriveOptions {
  /** The one activation a single step or retry executes. */
  readonly single?: ActivationId
  /** Park the run in `paused` once the single activation settled. */
  readonly pauseAfterSingle: boolean
}

/** One activation's execution context inside one drive call. */
interface ActivationContext {
  readonly projectId: ProjectId
  readonly runId: RunId
  /** Definition revision the run is pinned to, checked before any commit. */
  readonly runRevision: number
  /** Parameters the run started with, passed to every executor call. */
  readonly params: RunParams
  readonly definition: WorkflowDefinition
  /** The definition node this activation executes. */
  readonly node: WorkflowNode
  readonly edges: ReadonlyMap<string, WorkflowEdge>
  readonly activation: ActivationRow
}

/** One attempt outcome and everything the commit must write with it. */
interface CommitPlan {
  readonly attemptId: AttemptId
  /** 1-based attempt number this outcome belongs to. */
  readonly attemptNo: number
  readonly attemptStatus: 'succeeded' | 'failed' | 'waiting'
  readonly activationStatus: ActivationStatus
  /** Failure the attempt records, when it did not succeed. */
  readonly error?: NodeFailure
  /** JSON value a successful attempt committed. */
  readonly value?: JsonValue
  /** Files a successful attempt published. */
  readonly artifacts?: readonly NodeArtifact[]
  /** Failure that ends the run as well as the activation. */
  readonly failRun?: NodeFailure
  /** Accumulator for the decisions this commit takes. */
  readonly diagnostics: SchedulerDiagnostic[]
}

/**
 * The workflow scheduler service.
 *
 * One instance owns the executor registrations, the per-run in-flight abort
 * controllers, and the configuration every call reads; the durable state it
 * schedules from stays in the project database.
 */
export default class WorkflowScheduler extends Service {
  static inject = ['mwfProjectStore']

  static Config: z<Config> = Config

  private readonly executors = new ExecutorRegistry()
  private readonly settings: SchedulerSettings
  private readonly aborters = new Map<RunId, Set<AbortController>>()
  private readonly driving = new Map<RunId, Promise<TickResult>>()
  private closed = false

  /**
   * @param ctx - plugin context that owns the service lifetime.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mwfScheduler')
    this.settings = resolveSettings(config)
    ctx.effect(() => () => {
      this.dispose()
    }, 'workflowScheduler.dispose')
  }

  /**
   * Register the executor for one node kind.
   *
   * The registration is an effect: disposing the returned disposer, or the
   * plugin fiber, unregisters the executor.
   * @param executor - executor to register.
   * @returns the disposer that unregisters it.
   * @throws {@link WorkflowSchedulerError} `scheduler/duplicate-executor` when the
   * kind already has an executor, and `scheduler/closed` after disposal.
   */
  registerExecutor(executor: NodeExecutor): () => void {
    this.assertOpen()
    const registered = this.executors.register(executor)
    const dispose = this.ctx.effect(() => registered, `workflowScheduler.executor:${executor.kind}`)
    return () => {
      void dispose()
    }
  }

  /**
   * Start one run from a stored definition revision.
   *
   * The run and its entry activation are written in one transaction, so a run
   * never exists without the activation that starts it. The definition is
   * parsed and validated first: a revision that no longer describes an
   * executable graph is refused instead of recorded.
   * @param request - project, definition revision, and optional run parameters.
   * @returns the identity of the created run.
   * @throws {@link WorkflowSchedulerError} `scheduler/definition-unavailable` or
   * `scheduler/definition-invalid`, and `scheduler/closed` after disposal.
   */
  async createRun(request: CreateRunRequest): Promise<CreateRunResult> {
    this.assertOpen()
    const definition = await this.loadDefinition(request.projectId, request.definitionRevision)
    const entry = entryNode(definition)
    const runId = brandString<RunId>(randomUUID())
    const activationId = brandString<ActivationId>(randomUUID())
    const now = Date.now()
    const params: RunParams = request.params ?? {}
    await this.store.transact(request.projectId, (db) => {
      insertRun(db, {
        runId,
        definitionRevision: request.definitionRevision,
        status: 'pending',
        params,
        createdAt: now,
        updatedAt: now,
        reason: null,
      })
      insertActivation(db, {
        activationId,
        runId,
        nodeId: entry.id,
        iteration: 0,
        status: 'pending',
        incoming: [],
        createdAt: now,
        updatedAt: now,
      })
    })
    return { runId }
  }

  /**
   * Advance one run until nothing else can start.
   *
   * Ready activations start in document order, at most `maxConcurrent` at a
   * time, and each committed outcome immediately re-opens the readiness
   * question. The call returns when the run settles, pauses, or has only
   * waiting or in-flight work left. Calling it again on a settled run changes
   * nothing.
   * @param request - project and run to advance.
   * @returns what the call dispatched, committed, and decided.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` for an
   * unknown run, and `scheduler/closed` after disposal.
   */
  async tick(request: RunRequest): Promise<TickResult> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (isRunTerminal(run.status) || run.status === 'paused') return tickResult(run, 0, 0, [])
    return this.drive(request.projectId, request.runId, { pauseAfterSingle: false })
  }

  /**
   * Execute one named activation and then stop scheduling.
   *
   * The activation must be pending and its join must already be satisfied; a
   * run that settles as a result of the step keeps its settled status instead
   * of being parked again.
   * @param request - project, run, and the activation to execute.
   * @returns what the step dispatched and decided.
   * @throws {@link WorkflowSchedulerError} `scheduler/activation-not-found` when
   * the activation belongs to another run, `scheduler/activation-not-ready` when
   * its join does not fire yet, and `scheduler/run-state-invalid` for a terminal run.
   */
  async step(request: ActivationRequest): Promise<TickResult> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (isRunTerminal(run.status)) {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" already settled as ${run.status}`)
    }
    const activation = await this.requireActivation(request.projectId, request.runId, request.activationId)
    requirePendingActivation(activation, request.activationId)
    // Readiness is checked before the step reopens a paused run, so a refused
    // step leaves the run in the state it found.
    const definition = await this.loadDefinition(request.projectId, run.definitionRevision)
    const activations = await this.store.transact(request.projectId, db => selectRunActivations(db, request.runId))
    this.readyFor(definition, activations, { single: request.activationId, pauseAfterSingle: true })
    if (run.status === 'paused') {
      await this.store.transact(request.projectId, (db) => {
        updateRunStatus(db, request.runId, 'running', null, Date.now())
      })
    }
    return this.drive(request.projectId, request.runId, { single: request.activationId, pauseAfterSingle: true })
  }

  /**
   * Stop scheduling one run and abort its in-flight attempts.
   *
   * An attempt that was already running becomes `canceled` and its activation
   * returns to `pending`, so a resumed run re-executes it; a result that
   * arrives after the abort is stale and commits nothing.
   * @param request - project and run to pause.
   * @returns the run as it now reads.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` or `scheduler/run-state-invalid`.
   */
  async pause(request: RunRequest): Promise<RunView> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (isRunTerminal(run.status)) {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" already settled as ${run.status}`)
    }
    await this.store.transact(request.projectId, (db) => {
      const now = Date.now()
      for (const attempt of selectRunningAttempts(db)) {
        if (attempt.runId !== request.runId) continue
        updateAttemptOutcome(db, attempt.attemptId, 'canceled', now, null, undefined)
        updateActivationStatus(db, attempt.activationId, 'pending', now)
      }
      updateRunStatus(db, request.runId, 'paused', null, now)
    })
    this.abortRun(request.runId)
    return this.readRun(request.projectId, request.runId)
  }

  /**
   * Allow a paused run to continue.
   * @param request - project and run to resume.
   * @returns the run as it now reads.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-state-invalid` unless the run is paused.
   */
  async resume(request: RunRequest): Promise<RunView> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (run.status !== 'paused') {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" is ${run.status}, not paused`)
    }
    await this.store.transact(request.projectId, (db) => {
      updateRunStatus(db, request.runId, 'running', null, Date.now())
    })
    return this.readRun(request.projectId, request.runId)
  }

  /**
   * Cancel one run and every activation it has not finished.
   *
   * Committed results stay readable; a result that arrives after the abort is
   * stale and commits nothing.
   * @param request - project and run to cancel.
   * @returns the run as it now reads.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` or `scheduler/run-state-invalid`.
   */
  async cancel(request: RunRequest): Promise<RunView> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (isRunTerminal(run.status)) {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" already settled as ${run.status}`)
    }
    await this.store.transact(request.projectId, (db) => {
      const now = Date.now()
      for (const attempt of selectRunningAttempts(db)) {
        if (attempt.runId !== request.runId) continue
        updateAttemptOutcome(db, attempt.attemptId, 'canceled', now, null, undefined)
      }
      for (const activation of selectRunActivations(db, request.runId)) {
        if (!isTerminal(activation.status)) updateActivationStatus(db, activation.activationId, 'canceled', now)
      }
      updateRunStatus(db, request.runId, 'canceled', null, now)
    })
    this.abortRun(request.runId)
    return this.readRun(request.projectId, request.runId)
  }

  /**
   * Retry one settled or waiting activation as a new attempt.
   *
   * The activation returns to `pending` and is executed once; a run that had
   * failed reopens so the rest of the graph can continue, while a canceled run
   * stays canceled. History is kept: the earlier attempts remain readable.
   * @param request - project, run, and activation to retry.
   * @returns the identity of the attempt the retry created.
   * @throws {@link WorkflowSchedulerError} `scheduler/activation-not-found`,
   * `scheduler/activation-not-retryable` for a pending, running, or succeeded
   * activation, and `scheduler/run-state-invalid` for a canceled run.
   */
  async retry(request: ActivationRequest): Promise<RetryResult> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (run.status === 'canceled') {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" is canceled`)
    }
    const activation = await this.requireActivation(request.projectId, request.runId, request.activationId)
    if (activation.status === 'pending' || activation.status === 'running' || activation.status === 'succeeded') {
      throw new WorkflowSchedulerError(
        'scheduler/activation-not-retryable',
        `activation "${request.activationId}" is ${activation.status}, which a retry does not reopen`,
      )
    }
    await this.store.transact(request.projectId, (db) => {
      const now = Date.now()
      updateActivationStatus(db, request.activationId, 'pending', now)
      if (run.status !== 'running') updateRunStatus(db, request.runId, 'running', null, now)
    })
    await this.drive(request.projectId, request.runId, {
      single: request.activationId,
      pauseAfterSingle: false,
    })
    const attempts = await this.readAttempts(request.projectId, request.runId, request.activationId)
    // The single-activation drive starts one attempt once its readiness held.
    return { attemptId: (attempts[attempts.length - 1] as AttemptView).attemptId }
  }

  /**
   * Wake one waiting activation with the answer it asked for and advance the run.
   *
   * Only a waiting activation resumes; every other status is a caller mistake
   * (`scheduler/activation-not-resumable`), because starting, retrying, or
   * re-answering work would run a node whose question is not the one answered.
   * The answer is stored beside the activation's rows before the attempt runs,
   * so the resumed execution receives it even after a restart. A paused run is
   * reopened, because an answered decision is what it was waiting for.
   * @param request - project, run, waiting activation, and optional answer.
   * @returns what the call dispatched, committed, and decided.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-state-invalid` for a
   * settled run, `scheduler/activation-not-found`,
   * `scheduler/activation-not-resumable`, and `scheduler/closed` after disposal.
   */
  async resumeActivation(request: ResumeActivationRequest): Promise<TickResult> {
    this.assertOpen()
    const run = await this.readRun(request.projectId, request.runId)
    if (isRunTerminal(run.status)) {
      throw new WorkflowSchedulerError('scheduler/run-state-invalid', `run "${request.runId}" already settled as ${run.status}`)
    }
    const activation = await this.requireActivation(request.projectId, request.runId, request.activationId)
    if (activation.status !== 'waiting') {
      throw new WorkflowSchedulerError(
        'scheduler/activation-not-resumable',
        `activation "${request.activationId}" is ${activation.status}, not waiting for a decision`,
      )
    }
    await this.store.transact(request.projectId, (db) => {
      const now = Date.now()
      updateActivationStatus(db, request.activationId, 'pending', now)
      if (request.decision !== undefined) savePendingDecision(db, request.activationId, request.decision)
      if (run.status === 'paused') updateRunStatus(db, request.runId, 'running', null, now)
    })
    return this.drive(request.projectId, request.runId, { pauseAfterSingle: false })
  }

  /**
   * Recover one project after a backend restart.
   *
   * Every attempt still marked running becomes `interrupted`, its activation
   * returns to `pending`, and every running run is parked in `paused`; a human
   * (or the coordinator) then resumes or retries. Waiting activations keep
   * their state and are reported separately: their nodes are not interrupted,
   * and the answer that wakes them is still theirs to receive. The pass repairs
   * no Session tail: resuming a node's own conversation is the node executor's
   * job.
   * @param request - project to reconcile.
   * @returns the interrupted attempts, the parked runs, and the waiting activations.
   * @throws {@link WorkflowSchedulerError} `scheduler/closed` after disposal.
   */
  async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    this.assertOpen()
    return this.store.transact(request.projectId, (db) => {
      const now = Date.now()
      const interrupted: InterruptedAttempt[] = []
      for (const attempt of selectRunningAttempts(db)) {
        updateAttemptOutcome(db, attempt.attemptId, 'interrupted', now, null, undefined)
        // The attempt's activation exists: attempts reference activations.
        const activation = selectActivation(db, attempt.activationId) as ActivationRow
        updateActivationStatus(db, attempt.activationId, 'pending', now)
        interrupted.push({
          runId: attempt.runId,
          activationId: attempt.activationId,
          attemptId: attempt.attemptId,
          nodeId: activation.nodeId,
          iteration: activation.iteration,
        })
      }
      // Reading before the runs are parked reports every waiting activation the
      // previous backend left, independently of which runs this pass parks.
      const waiting: WaitingActivation[] = selectWaitingAttempts(db).map(attempt => ({
        runId: attempt.runId,
        activationId: attempt.activationId,
        attemptId: attempt.attemptId,
        nodeId: attempt.nodeId,
        iteration: attempt.iteration,
      }))
      const paused: RunId[] = []
      for (const run of selectRuns(db)) {
        if (run.status !== 'running') continue
        updateRunStatus(db, run.runId, 'paused', 'recovered after restart', now)
        paused.push(run.runId)
      }
      return { interrupted, paused, waiting }
    })
  }

  /**
   * One run as it reads now.
   * @param request - project and run to read.
   * @returns the run, or `undefined` when the project holds no such run.
   * @throws {@link WorkflowSchedulerError} `scheduler/closed` after disposal.
   */
  async getRun(request: RunRequest): Promise<RunView | undefined> {
    this.assertOpen()
    const run = await this.store.transact(request.projectId, db => selectRun(db, request.runId))
    return run === undefined ? undefined : runView(run)
  }

  /**
   * Every activation of one run, in creation order.
   * @param request - project and run to read.
   * @returns the activations.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` for an unknown run.
   */
  async listActivations(request: RunRequest): Promise<ActivationView[]> {
    this.assertOpen()
    await this.readRun(request.projectId, request.runId)
    const activations = await this.store.transact(request.projectId, db => selectRunActivations(db, request.runId))
    return activations.map(activationView)
  }

  /**
   * Attempts of one run, oldest first.
   * @param request - project and run to read, optionally narrowed to one activation.
   * @returns the attempts.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` for an unknown run.
   */
  async listAttempts(request: RunRequest & { readonly activationId?: ActivationId }): Promise<AttemptView[]> {
    this.assertOpen()
    await this.readRun(request.projectId, request.runId)
    return this.readAttempts(request.projectId, request.runId, request.activationId)
  }

  /** Abort every in-flight attempt and drop every registration. */
  private dispose(): void {
    this.closed = true
    for (const controllers of this.aborters.values()) {
      for (const controller of controllers) controller.abort('scheduler disposed')
    }
    this.aborters.clear()
    this.executors.clear()
  }

  /**
   * Refuse work once the service is disposed.
   * @returns nothing.
   * @throws {@link WorkflowSchedulerError} `scheduler/closed`.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new WorkflowSchedulerError('scheduler/closed', 'the workflow scheduler is closed')
    }
  }

  /** The project store this scheduler reads and writes through. */
  private get store(): ProjectStore {
    return this.ctx.mwfProjectStore
  }

  /**
   * Parse and validate one stored definition revision.
   * @param projectId - project holding the revision.
   * @param revision - revision to read.
   * @returns the executable definition.
   * @throws {@link WorkflowSchedulerError} `scheduler/definition-unavailable` or
   * `scheduler/definition-invalid`.
   */
  private async loadDefinition(projectId: ProjectId, revision: number): Promise<WorkflowDefinition> {
    const record = await this.store.readDefinition(projectId, revision)
    if (record === undefined) {
      throw new WorkflowSchedulerError(
        'scheduler/definition-unavailable',
        `workflow project "${projectId}" stores no definition revision ${String(revision)}`,
      )
    }
    const parsed = parseDefinitionDocument(record.document)
    if (!parsed.ok) {
      const reasons = parsed.violations.map(violation => `${violation.code} at "${violation.path}"`).join(', ')
      throw new WorkflowSchedulerError(
        'scheduler/definition-invalid',
        `definition revision ${String(revision)} of project "${projectId}" is not executable: ${reasons}`,
      )
    }
    return parsed.definition
  }

  /**
   * Read one run, or refuse.
   * @param projectId - project holding the run.
   * @param runId - run to read.
   * @returns the run record.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found`.
   */
  private async readRun(projectId: ProjectId, runId: RunId): Promise<RunRow> {
    return this.store.transact(projectId, db => requireRun(db, runId))
  }

  /**
   * Read one activation of one run, or refuse.
   * @param projectId - project holding the run.
   * @param runId - run the activation belongs to.
   * @param activationId - activation to read.
   * @returns the activation record.
   * @throws {@link WorkflowSchedulerError} `scheduler/activation-not-found`.
   */
  private async requireActivation(
    projectId: ProjectId,
    runId: RunId,
    activationId: ActivationId,
  ): Promise<ActivationRow> {
    const activation = await this.store.transact(projectId, db => selectActivation(db, activationId))
    if (activation === undefined || activation.runId !== runId) {
      throw new WorkflowSchedulerError(
        'scheduler/activation-not-found',
        `run "${runId}" holds no activation "${activationId}"`,
      )
    }
    return activation
  }

  /**
   * Attempts of one run, oldest first.
   * @param projectId - project holding the run.
   * @param runId - run whose attempts are read.
   * @param activationId - optional activation to narrow to.
   * @returns the attempt views.
   */
  private async readAttempts(
    projectId: ProjectId,
    runId: RunId,
    activationId?: ActivationId,
  ): Promise<AttemptView[]> {
    const rows = await this.store.transact(projectId, db => activationId === undefined
      ? selectRunAttempts(db, runId)
      : selectActivationAttempts(db, activationId))
    return rows.map(attemptView)
  }

  /**
   * Drive one run, serializing concurrent drives of the same run.
   * @param projectId - project holding the run.
   * @param runId - run to drive.
   * @param options - whether this drive executes one named activation.
   * @returns what the drive dispatched, committed, and decided.
   */
  private async drive(projectId: ProjectId, runId: RunId, options: DriveOptions): Promise<TickResult> {
    const current = this.driving.get(runId)
    if (current !== undefined) await current
    const promise = this.runDrive(projectId, runId, options)
    this.driving.set(runId, promise)
    try {
      return await promise
    } finally {
      this.driving.delete(runId)
    }
  }

  /**
   * The scheduling loop of one drive call.
   * @param projectId - project holding the run.
   * @param runId - run to drive.
   * @param options - whether this drive executes one named activation.
   * @returns what the drive dispatched, committed, and decided.
   */
  private async runDrive(projectId: ProjectId, runId: RunId, options: DriveOptions): Promise<TickResult> {
    const diagnostics: SchedulerDiagnostic[] = []
    let dispatched = 0
    let completed = 0
    let failure: { readonly error: unknown } | undefined
    const inFlight = new Set<Promise<void>>()
    const claimed = new Set<ActivationId>()
    const first = await this.readRun(projectId, runId)
    if (first.status === 'pending') {
      await this.store.transact(projectId, (db) => {
        startRunIfPending(db, runId, Date.now())
      })
    }
    const definition = await this.loadDefinition(projectId, first.definitionRevision)
    const nodes = nodeIndex(definition)
    const edges = edgeIndex(definition)
    for (;;) {
      const run = await this.store.transact(projectId, db => requireRun(db, runId))
      if (isRunTerminal(run.status)) break
      if (run.status === 'paused' && options.single === undefined) break
      const activations = await this.store.transact(projectId, db => selectRunActivations(db, runId))
      const ready = this.readyFor(definition, activations, options)
        .filter(activation => !claimed.has(activation.activationId))
      const slots = this.settings.maxConcurrent - inFlight.size
      if (ready.length > 0 && slots > 0) {
        for (const activation of ready.slice(0, slots)) {
          claimed.add(activation.activationId)
          dispatched += 1
          const context: ActivationContext = {
            projectId,
            runId,
            runRevision: run.definitionRevision,
            params: run.params,
            definition,
            node: requireNode(nodes, activation.nodeId),
            edges,
            activation,
          }
          this.track(inFlight, this.runActivation(context, diagnostics).then((committed) => {
            if (committed) completed += 1
          }, (error: unknown) => {
            failure ??= { error }
          }))
        }
        continue
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight)
        continue
      }
      break
    }
    if (inFlight.size > 0) await Promise.all(inFlight)
    if (failure !== undefined) throw failure.error
    const settled = await this.settle(projectId, runId, options)
    return tickResult(settled, dispatched, completed, diagnostics)
  }

  /**
   * The activations one pass may start.
   * @param definition - the run's definition.
   * @param activations - every activation of the run.
   * @param options - whether the pass is a single step or retry.
   * @returns the ready activations to start now.
   * @throws {@link WorkflowSchedulerError} `scheduler/activation-not-ready` when a
   * single step names an activation whose join does not fire.
   */
  private readyFor(
    definition: WorkflowDefinition,
    activations: readonly ActivationRow[],
    options: DriveOptions,
  ): ActivationRow[] {
    if (options.single === undefined) return readyActivations(definition, activations)
    const activation = activations.find(candidate => candidate.activationId === options.single)
    if (activation === undefined || activation.status !== 'pending') return []
    const node = requireNode(nodeIndex(definition), activation.nodeId)
    const ready = activationReady(definition, node, activation, activationIndex(activations))
    if (!ready) {
      throw new WorkflowSchedulerError(
        'scheduler/activation-not-ready',
        `activation "${activation.activationId}" waits for incoming activations that have not succeeded`,
      )
    }
    return [activation]
  }

  /**
   * Settle the run if nothing can run any more, then honor a single step.
   * @param projectId - project holding the run.
   * @param runId - run to settle.
   * @param options - whether this drive was a single step.
   * @returns the run as it now reads.
   * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found`.
   */
  private async settle(projectId: ProjectId, runId: RunId, options: DriveOptions): Promise<RunRow> {
    return this.store.transact(projectId, (db) => {
      const run = requireRun(db, runId)
      if (run.status !== 'running') return run
      const now = Date.now()
      const settled = settleStatus(selectRunActivations(db, runId))
      if (settled !== undefined) {
        updateRunStatus(db, runId, settled, null, now)
        return { ...run, status: settled, reason: null, updatedAt: now }
      }
      if (!options.pauseAfterSingle) return run
      updateRunStatus(db, runId, 'paused', null, now)
      return { ...run, status: 'paused', updatedAt: now }
    })
  }

  /**
   * Execute one activation: assemble its inputs, run the node, commit its
   * outcome, and retry a retryable failure while the attempt budget lasts.
   * @param context - the activation, its node, and the graph it belongs to.
   * @param diagnostics - accumulator for the decisions this execution takes.
   * @returns whether a terminal outcome was committed for the activation.
   */
  private async runActivation(context: ActivationContext, diagnostics: SchedulerDiagnostic[]): Promise<boolean> {
    const { projectId, activation, node } = context
    let attemptNo = await this.nextAttemptNo(projectId, activation.activationId)
    for (;;) {
      const attemptId = await this.startAttempt(projectId, activation.activationId, attemptNo)
      // Read per attempt, so a retry of a resumed activation receives the same
      // answer until one attempt commits an outcome for it.
      const decision = await this.store.transact(projectId, db => selectPendingDecision(db, activation.activationId))
      const inputs = await this.assemble(context)
      if (inputs.kind === 'missing') {
        const error = {
          code: 'scheduler/input-missing',
          message: `input "${inputs.binding.name}" of node "${node.id}" has no value from ${inputs.binding.source.kind}`,
        }
        diagnostics.push({ code: 'scheduler/input-missing', message: error.message, nodeId: node.id, activationId: activation.activationId, attemptId })
        return await this.commit(context, {
          attemptId,
          attemptNo,
          attemptStatus: 'failed',
          activationStatus: 'failed',
          error,
          failRun: error,
          diagnostics,
        })
      }
      const executor = this.executors.find(node.kind)
      if (executor === undefined) {
        const error = {
          code: 'scheduler/executor-missing',
          message: `no executor is registered for node kind "${node.kind}"`,
        }
        diagnostics.push({ code: 'scheduler/executor-missing', message: error.message, nodeId: node.id, activationId: activation.activationId, attemptId })
        return await this.commit(context, {
          attemptId,
          attemptNo,
          attemptStatus: 'failed',
          activationStatus: 'failed',
          error,
          failRun: error,
          diagnostics,
        })
      }
      const result = await this.execute(executor, context, inputs.inputs, attemptNo, attemptId, decision)
      if (result.status === 'failed' && result.retryable && attemptNo < this.settings.maxAttempts) {
        await this.recordRetryableFailure(projectId, attemptId, result.error)
        attemptNo += 1
        continue
      }
      if (result.status === 'succeeded') {
        return await this.commit(context, {
          attemptId,
          attemptNo,
          attemptStatus: 'succeeded',
          activationStatus: 'succeeded',
          value: result.value,
          artifacts: result.artifacts ?? [],
          diagnostics,
        })
      }
      if (result.status === 'waiting') {
        return await this.commit(context, {
          attemptId,
          attemptNo,
          attemptStatus: 'waiting',
          activationStatus: 'waiting',
          error: {
            code: 'scheduler/waiting',
            message: `node "${node.id}" waits for decision "${result.requestId}"`,
          },
          diagnostics,
        })
      }
      diagnostics.push({
        code: 'scheduler/node-failed',
        message: `node "${node.id}" failed with ${result.error.code}: ${result.error.message}`,
        nodeId: node.id,
        activationId: activation.activationId,
        attemptId,
      })
      return await this.commit(context, {
        attemptId,
        attemptNo,
        attemptStatus: 'failed',
        activationStatus: 'failed',
        error: result.error,
        failRun: result.error,
        diagnostics,
      })
    }
  }

  /**
   * Run one executor call under an abort controller registered for the run.
   * @param executor - executor of the node's kind.
   * @param context - the activation being executed.
   * @param inputs - the assembled input values.
   * @param attemptNo - 1-based attempt number.
   * @param attemptId - the attempt row this execution runs under.
   * @param decision - the answer that resumed this activation, when one is stored.
   * @returns the node's outcome; a rejection becomes a structured failure.
   */
  private async execute(
    executor: NodeExecutor,
    context: ActivationContext,
    inputs: NodeInputs,
    attemptNo: number,
    attemptId: AttemptId,
    decision: JsonValue | undefined,
  ): Promise<NodeResult> {
    const controller = new AbortController()
    this.controllers(context.runId).add(controller)
    try {
      return await executor.execute({
        runId: context.runId,
        activationId: context.activation.activationId,
        node: context.node,
        projectId: context.projectId,
        definitionRevision: context.runRevision,
        iteration: context.activation.iteration,
        attemptNo,
        attemptId,
        params: context.params,
        ...decision === undefined ? {} : { decision },
      }, inputs, controller.signal)
    } catch (error: unknown) {
      return { status: 'failed', error: { code: 'scheduler/executor-error', message: String(error) }, retryable: false }
    } finally {
      this.controllers(context.runId).delete(controller)
    }
  }

  /**
   * Assemble one activation's inputs from the run's committed values.
   * @param context - the activation, its node, and the graph it belongs to.
   * @returns the input values, or the binding that resolved to nothing.
   */
  private async assemble(
    context: ActivationContext,
  ): Promise<
    | { readonly kind: 'inputs'; readonly inputs: NodeInputs }
    | { readonly kind: 'missing'; readonly binding: InputBinding }
  > {
    const { projectId, runId, activation } = context
    const state = await this.store.transact(projectId, db => ({
      activations: selectRunActivations(db, runId),
      attempts: selectRunAttempts(db, runId),
      artifacts: selectRunArtifacts(db, runId),
    }))
    const results = new Map<string, Map<number, JsonValue>>()
    for (const owner of state.activations) {
      const attempt = state.attempts.find(candidate => candidate.activationId === owner.activationId)
      const value = attempt?.result
      if (value === undefined) continue
      const byIteration = results.get(owner.nodeId) ?? new Map<number, JsonValue>()
      byIteration.set(owner.iteration, value)
      results.set(owner.nodeId, byIteration)
    }
    const artifacts = new Map<string, ArtifactRow>()
    for (const artifact of state.artifacts) artifacts.set(artifact.name, artifact)
    const assembly = assembleInputs(context.node, activation.iteration, {
      params: context.params,
      result: (nodeId, iteration) => {
        const byIteration = results.get(nodeId)
        if (byIteration === undefined) return undefined
        // One node's activations are created in ascending iteration order, so the
        // last entry at or before this iteration is its newest committed result.
        let latest: JsonValue | undefined
        for (const [candidate, value] of byIteration) {
          if (candidate > iteration) continue
          latest = value
        }
        return latest
      },
      artifact: name => artifacts.get(name),
    })
    return assembly.ok ? { kind: 'inputs', inputs: assembly.inputs } : { kind: 'missing', binding: assembly.binding }
  }

  /**
   * The attempt number the next execution of one activation uses.
   * @param projectId - project holding the run.
   * @param activationId - activation whose attempts are counted.
   * @returns one more than the highest attempt number recorded.
   */
  private async nextAttemptNo(projectId: ProjectId, activationId: ActivationId): Promise<number> {
    const attempts = await this.store.transact(projectId, db => selectActivationAttempts(db, activationId))
    return attempts.reduce((highest, attempt) => Math.max(highest, attempt.attemptNo), 0) + 1
  }

  /**
   * Record the start of one attempt and mark its activation running.
   *
   * A pending activation starts its first attempt and a running one continues
   * with the next attempt after a retryable failure. Any other status means the
   * activation was finished, paused, or canceled while it waited, which is what
   * keeps a stale execution from starting.
   * @param projectId - project holding the run.
   * @param activationId - activation being executed.
   * @param attemptNo - 1-based attempt number.
   * @returns the attempt identity.
   */
  private async startAttempt(
    projectId: ProjectId,
    activationId: ActivationId,
    attemptNo: number,
  ): Promise<AttemptId> {
    const attemptId = brandString<AttemptId>(randomUUID())
    return this.store.transact(projectId, (db) => {
      // The activation row exists: this transaction updates it.
      requirePendingActivation(selectActivation(db, activationId) as ActivationRow, activationId)
      const now = Date.now()
      updateActivationStatus(db, activationId, 'running', now)
      insertAttempt(db, { attemptId, activationId, attemptNo, status: 'running', startedAt: now })
      return attemptId
    })
  }

  /**
   * Commit one attempt's outcome together with everything that follows from it.
   *
   * The attempt result, the activation and run transitions, the artifacts the
   * node published, the routed successor activations, and the staged outbox
   * event are one batch: a write that fails leaves none of them behind, and an
   * outcome that stopped being current commits nothing at all.
   * @param context - the activation, its node, and the graph it belongs to.
   * @param plan - the outcome to record and what it implies.
   * @returns whether the outcome was committed.
   */
  private async commit(context: ActivationContext, plan: CommitPlan): Promise<boolean> {
    return this.store.transact(context.projectId, (db) => {
      const now = Date.now()
      if (!this.commitAllowed(db, context, plan.attemptId, plan.diagnostics)) return false
      updateAttemptOutcome(db, plan.attemptId, plan.attemptStatus, now, plan.error ?? null, plan.value)
      // The answer is consumed by the outcome, whatever it was: a later retry
      // must not receive an answer the node already acted on.
      clearPendingDecision(db, context.activation.activationId)
      updateActivationStatus(db, context.activation.activationId, plan.activationStatus, now)
      if (plan.attemptStatus !== 'waiting') {
        insertOutboxEvent(db, plan.attemptId, 0, JSON.stringify({
          type: 'scheduler/attempt-result',
          runId: context.runId,
          activationId: context.activation.activationId,
          nodeId: context.node.id,
          iteration: context.activation.iteration,
          attemptNo: plan.attemptNo,
          status: plan.attemptStatus,
          ...(plan.value === undefined ? {} : { value: plan.value }),
          ...(plan.error === undefined ? {} : { error: plan.error }),
        }))
      }
      for (const artifact of plan.artifacts ?? []) {
        this.publishArtifact(db, context.activation.activationId, plan.attemptId, artifact)
      }
      if (plan.failRun !== undefined) {
        this.failRunMessage(db, context.runId, `${plan.failRun.code}: ${plan.failRun.message}`, now)
      }
      if (plan.attemptStatus === 'succeeded') {
        this.routeSuccess(db, context, plan.attemptId, plan.value, plan.diagnostics, now)
      }
      return true
    })
  }

  /**
   * Activate the targets one successful result routes to.
   * @param db - open project connection inside the commit transaction.
   * @param context - the activation, its node, and the graph it belongs to.
   * @param attemptId - attempt whose result was committed.
   * @param value - the node's JSON result.
   * @param diagnostics - accumulator for the routing decision.
   * @param now - epoch milliseconds of the commit.
   * @returns nothing.
   */
  private routeSuccess(
    db: DatabaseSync,
    context: ActivationContext,
    attemptId: AttemptId,
    value: JsonValue | undefined,
    diagnostics: SchedulerDiagnostic[],
    now: number,
  ): void {
    const routing = route(value ?? null, context.node, context.definition.edges)
    if (routing.failure !== null) {
      this.failRun(db, context, routing.failure, attemptId, diagnostics)
      return
    }
    for (const edgeId of routing.edgeIds) {
      // Routing only reports edges of this definition.
      const edge = context.edges.get(edgeId) as WorkflowEdge
      const iteration = targetIteration(context.activation.iteration, edge)
      const bound = edge.loop?.maxIterations
      if (bound !== undefined && iteration > bound) {
        const message = `loop edge "${edge.id}" would re-enter node "${edge.to}" at iteration ${String(iteration)}, beyond ${String(bound)}`
        diagnostics.push({
          code: 'scheduler/loop-exhausted',
          message,
          nodeId: edge.to,
          activationId: context.activation.activationId,
          attemptId,
        })
        this.failRunMessage(db, context.runId, `scheduler/loop-exhausted: ${message}`, now)
        return
      }
      this.activateTarget(db, context, edge, iteration, now)
    }
  }

  /**
   * Record one retryable failure without ending the activation.
   * @param projectId - project holding the run.
   * @param attemptId - attempt that failed.
   * @param error - the structured failure.
   * @returns nothing.
   */
  private async recordRetryableFailure(
    projectId: ProjectId,
    attemptId: AttemptId,
    error: { readonly code: string; readonly message: string },
  ): Promise<void> {
    await this.store.transact(projectId, (db) => {
      updateAttemptOutcome(db, attemptId, 'failed', Date.now(), error, undefined)
    })
  }

  /**
   * Whether one attempt may still commit its outcome.
   * @param db - open project connection inside the commit transaction.
   * @param context - the activation, its node, and the graph it belongs to.
   * @param attemptId - attempt about to commit.
   * @param diagnostics - accumulator for the stale decision.
   * @returns `true` when the attempt is still the running attempt of a run pinned to this revision.
   */
  private commitAllowed(
    db: DatabaseSync,
    context: ActivationContext,
    attemptId: AttemptId,
    diagnostics: SchedulerDiagnostic[],
  ): boolean {
    // The attempt row exists: this transaction updates it.
    const attempt = selectAttempt(db, attemptId) as AttemptRow
    const run = requireRun(db, context.runId)
    const reason = attempt.status !== 'running'
      ? 'the attempt is no longer running'
      : run.definitionRevision !== context.runRevision
        ? 'the run moved to another definition revision'
        : undefined
    if (reason === undefined) return true
    diagnostics.push({
      code: 'scheduler/stale-result',
      message: `result of attempt "${attemptId}" was not committed: ${reason}`,
      nodeId: context.activation.nodeId,
      activationId: context.activation.activationId,
      attemptId,
    })
    return false
  }

  /**
   * Publish one artifact of a successful activation under the next version of
   * its name.
   * @param db - open project connection.
   * @param activationId - activation that published it.
   * @param attemptId - attempt that produced it.
   * @param artifact - the published file.
   * @returns nothing.
   */
  private publishArtifact(
    db: DatabaseSync,
    activationId: ActivationId,
    attemptId: AttemptId,
    artifact: NodeArtifact,
  ): void {
    insertArtifact(db, {
      artifactId: randomUUID(),
      activationId,
      attemptId,
      name: artifact.name,
      version: nextArtifactVersion(db, activationId, artifact.name),
      path: artifact.path,
      sha256: artifact.sha256 ?? null,
    })
  }

  /**
   * Activate one routed target, extending the activation when another edge
   * already reached the same node in the same iteration.
   * @param db - open project connection inside the commit transaction.
   * @param context - the activation and the graph it belongs to.
   * @param edge - the routed edge.
   * @param iteration - iteration the target is activated in.
   * @param now - epoch milliseconds of the commit.
   * @returns nothing.
   */
  private activateTarget(
    db: DatabaseSync,
    context: ActivationContext,
    edge: WorkflowEdge,
    iteration: number,
    now: number,
  ): void {
    const incoming: IncomingActivation = { nodeId: context.activation.nodeId, iteration: context.activation.iteration }
    const existing = selectRunActivations(db, context.runId)
      .find(candidate => candidate.nodeId === edge.to && candidate.iteration === iteration)
    if (existing === undefined) {
      insertActivation(db, {
        activationId: brandString<ActivationId>(randomUUID()),
        runId: context.runId,
        nodeId: edge.to,
        iteration,
        status: 'pending',
        incoming: [incoming],
        createdAt: now,
        updatedAt: now,
      })
      return
    }
    if (existing.status !== 'pending') return
    const already = existing.incoming.some(candidate => candidate.nodeId === incoming.nodeId && candidate.iteration === incoming.iteration)
    if (already) return
    updateActivationIncoming(db, existing.activationId, [...existing.incoming, incoming], now)
  }

  /**
   * Fail one run from a routing failure, recording the diagnostic.
   * @param db - open project connection inside the commit transaction.
   * @param context - the activation and the graph it belongs to.
   * @param failure - the failure `route` reported.
   * @param attemptId - attempt whose routed result could not be decided.
   * @param diagnostics - accumulator for the routing decision.
   * @returns nothing.
   */
  private failRun(
    db: DatabaseSync,
    context: ActivationContext,
    failure: RoutingFailure,
    attemptId: AttemptId,
    diagnostics: SchedulerDiagnostic[],
  ): void {
    diagnostics.push({
      code: failure.code,
      message: failure.message,
      nodeId: failure.nodeId,
      activationId: context.activation.activationId,
      attemptId,
    })
    this.failRunMessage(db, context.runId, routingFailureReason(failure), Date.now())
  }

  /**
   * Move one run to `failed` unless it already settled.
   * @param db - open project connection inside the commit transaction.
   * @param runId - run to fail.
   * @param reason - why the run failed.
   * @param now - epoch milliseconds of the commit.
   * @returns nothing.
   */
  private failRunMessage(db: DatabaseSync, runId: RunId, reason: string, now: number): void {
    const run = requireRun(db, runId)
    if (run.status === 'failed' || run.status === 'canceled') return
    updateRunStatus(db, runId, 'failed', reason, now)
  }

  /**
   * The abort controllers of one run.
   * @param runId - run whose controllers are needed.
   * @returns the run's controller set, created on first use.
   */
  private controllers(runId: RunId): Set<AbortController> {
    const existing = this.aborters.get(runId)
    if (existing !== undefined) return existing
    const created = new Set<AbortController>()
    this.aborters.set(runId, created)
    return created
  }

  /**
   * Add one dispatched execution to the pass's in-flight set, removing it when it settles.
   * @param inFlight - set of executions this pass is waiting on.
   * @param task - execution to track; it never rejects.
   * @returns nothing.
   */
  private track(inFlight: Set<Promise<void>>, task: Promise<void>): void {
    inFlight.add(task)
    void task.then(() => {
      inFlight.delete(task)
    })
  }

  /**
   * Abort every in-flight attempt of one run.
   * @param runId - run to abort.
   * @returns nothing.
   */
  private abortRun(runId: RunId): void {
    const controllers = this.aborters.get(runId)
    if (controllers === undefined) return
    for (const controller of controllers) controller.abort('workflow run stopped scheduling')
    this.aborters.delete(runId)
  }
}

/**
 * Require the run one transaction works on.
 * @param db - open project connection.
 * @param runId - run the caller addressed.
 * @returns the run row.
 * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` when a run the
 * project database guarantees exists is absent.
 */
function requireRun(db: DatabaseSync, runId: RunId): RunRow {
  const run = selectRun(db, runId)
  if (run === undefined) {
    throw new WorkflowSchedulerError('scheduler/run-not-found', `the project database holds no run "${runId}"`)
  }
  return run
}

/**
 * Require an activation that may still start an attempt.
 * @param activation - the activation the caller addressed, if it exists.
 * @param activationId - its id, for the diagnostic.
 * @returns the activation.
 * @throws {@link WorkflowSchedulerError} `scheduler/activation-not-ready` when the
 * activation is no longer pending or running.
 */
function requirePendingActivation(activation: ActivationRow, activationId: ActivationId): ActivationRow {
  if (activation.status !== 'pending' && activation.status !== 'running') {
    throw new WorkflowSchedulerError(
      'scheduler/activation-not-ready',
      `activation "${activationId}" is not ready to run`,
    )
  }
  return activation
}

/**
 * Build one tick result.
 * @param run - the run the call finished with.
 * @param dispatched - attempts the call started.
 * @param completed - attempts the call committed an outcome for.
 * @param diagnostics - decisions the call took.
 * @returns the tick result.
 */
function tickResult(
  run: RunRow,
  dispatched: number,
  completed: number,
  diagnostics: readonly SchedulerDiagnostic[],
): TickResult {
  return { runId: run.runId, status: run.status, dispatched, completed, diagnostics }
}

/**
 * One run row as a caller reads it.
 * @param run - the stored run.
 * @returns the run view.
 */
function runView(run: RunRow): RunView {
  return {
    runId: run.runId,
    definitionRevision: run.definitionRevision,
    status: run.status,
    params: run.params,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    reason: run.reason,
  }
}

/**
 * One activation row as a caller reads it.
 * @param activation - the stored activation.
 * @returns the activation view.
 */
function activationView(activation: ActivationRow): ActivationView {
  return {
    activationId: activation.activationId,
    runId: activation.runId,
    nodeId: activation.nodeId,
    iteration: activation.iteration,
    status: activation.status,
    incoming: activation.incoming,
    createdAt: activation.createdAt,
    updatedAt: activation.updatedAt,
  }
}

/**
 * One attempt row as a caller reads it.
 * @param attempt - the stored attempt.
 * @returns the attempt view.
 */
function attemptView(attempt: AttemptRow): AttemptView {
  return {
    attemptId: attempt.attemptId,
    activationId: attempt.activationId,
    attemptNo: attempt.attemptNo,
    status: attempt.status,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    error: attempt.error,
  }
}

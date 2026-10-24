# Workflow

English | [中文](workflow.zh.md)

The workflow seam lets an agent run a model-written orchestration SCRIPT that starts subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). Like bash, it permits ONE engine implementation per context to provide `ctx.workflowEngine`; there is no named-provider registry (a second engine replaces the first through plugin configuration rather than running beside it).

Service Definition: [mwf-workflow](../../packages/workflow/workflow) (`ctx.workflowEngine` and the vocabulary below). [mwf-workflow-ptc](../../packages/workflow/workflow-ptc) executes the VM and helpers through the shared Node PTC process runtime under the calling Session's file policy. The consumers are [mwf-tool-workflow](../../packages/workflow/tool-workflow) and the opt-in [mwf-tool-ralph](../../packages/experimental/tool-ralph). [Workflow sandbox reuse](../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) owns execution choices; the [dynamic-workflows reference](../../packages/workflow/workflow/README.md) owns script semantics.

Sources: browser-safe vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts), Host request and live-run handles in [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts).

## The start request

What a caller asks for when starting a run. The ordinary workflow tool builds this from the model's `{ script, meta, args }` call plus the calling agent; specialized consumers may also select one engine-wide `subagentProvider` and lower `maxTotalAgents` for the run, but the script cannot observe or replace either policy. `meta` and `args` are plain JSON DATA (the engine validates `meta` against its schema and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script starts is attributed to it, and cwd, lineage, and depth pass through the [subagent seam](subagent.md).

```ts type-equiv
/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}
```

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

```ts type-equiv
/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}
```

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (cancellation or
   * process failure) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}
```

## A live run: `WorkflowRun`

The consumer awaits `result`, may `cancel` during execution, and must `dispose` on every path. `result` never rejects: script failure resolves with `stopReason: 'error'`, and cancellation with `'cancelled'`. The PTC engine has no overall elapsed deadline; it immediately aborts the managed process when cancelled. Disposal awaits process and child cleanup under their provider contracts, without an independent workflow cleanup deadline.

```ts type-equiv
/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await script and child cleanup. */
  dispose(): Promise<void>
}
```

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](#cordis-surface)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.

## Durable Chat records

The top-level `mwf-tool-workflow` consumer projects display facts into its calling parent Session without changing execution ownership. It writes `tool-workflow/run-start` after a run is accepted, pairs member start and end by `runId + seq`, and writes `tool-workflow/run-end` only after the result is known and disposal reaches quiescence. Nested transport calls write no record. The first append failure disables later writes for that run, so the log remains empty or a legal continuous prefix and the tool result is unchanged.

The record protocol allows one start per run, positive unique member sequences, paired member endings, no run ending with open members, and no updates after the run ending. A missing member ending or run ending at the log tail is valid interruption evidence rather than corruption.

`mwf-client-ui-workflow-run` folds the four events through the Conversation Node engine into one `workflow-run` Chat node anchored at the run-start sequence, after the original workflow tool node. Phase groups come only from actual member starts and preserve exact strings, including the distinction between an omitted phase and `''`. Closed Locations turn missing terminal facts into interrupted presentation. The [UI package README](../../packages/client/ui-workflow-run/README.md) owns disclosure, status, and same-parent local navigation behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmwfprojectstore--workflowprojectstore"></a>

### `ctx.mwfProjectStore` — `WorkflowProjectStore`

The workflow project store service.

The registry database opens on first use and every project database opens when its project is first touched; each connection stays open until the service is disposed or its project is removed from the registry. Writes are serialized per database, so concurrent callers never rely on `busy_timeout` to order them.

```ts cordis-catalog
/**
 * Every registered project, newest first.
 * @returns the registry records in registry order.
 */
async listProjects(): Promise<ProjectRecord[]>

/**
 * Register a new project and materialize its working directory and database.
 *
 * The registry row is written first, so a directory already claimed by another
 * project fails before any file is created; a working directory or database
 * that then fails to materialize removes the row it just wrote. The database
 * always lands in the store's own project directory, whatever directory the
 * caller asked for, so the working directory never holds a store file.
 * @param request - title and optional working directory.
 * @returns the registered project record.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty title,
 * `project-path-in-use` when another project claims the directory, and
 * `open-failed` when the working directory or project database cannot be created.
 */
async createProject(request: CreateProjectRequest): Promise<ProjectRecord>

/**
 * Open one project: require its working directory, and materialize its
 * database when the file is absent or still sits in an older library.
 * @param projectId - registered project to open.
 * @returns the registry record of the opened project.
 * @throws {@link WorkflowProjectStoreError} `invalid-project-id`, `project-not-found`,
 * `project-directory-missing` when the working directory is gone,
 * `relocation-failed` when an older database cannot be moved out of it, or the
 * project database's open failure.
 */
async openProject(projectId: ProjectId): Promise<ProjectRecord>

/**
 * Replace one project's display title.
 *
 * The registry row is the title's only owner, so a renaming consumer never
 * keeps a second title store. Titles may repeat across projects; the
 * directory stays the registry's uniqueness key.
 * @param projectId - registered project to rename.
 * @param title - the new display title; surrounding whitespace is trimmed and
 * an empty result is refused.
 * @returns the updated registry record.
 * @throws {@link WorkflowProjectStoreError} `invalid-project-id`, `project-not-found`,
 * or `invalid-request` for a blank title.
 */
async renameProject(projectId: ProjectId, title: string): Promise<ProjectRecord>

/**
 * Remove one project from the registry.
 *
 * The project's connection is closed first; its working directory keeps every
 * file unless `deleteDirectory` asks for removal. Removing the directory also
 * removes the project's database, which the registration owns and nothing
 * else references. The returned directory is what a caller shows the human
 * before deciding.
 * @param projectId - registered project to remove.
 * @param options - whether to delete the working directory and the project database.
 * @returns the absolute working directory that is no longer registered.
 * @throws {@link WorkflowProjectStoreError} `invalid-project-id` or `project-not-found`.
 */
async removeProject(projectId: ProjectId, options: RemoveProjectOptions = {}): Promise<string>

/**
 * Read one definition revision, or the newest one.
 * @param projectId - registered project to read.
 * @param revision - revision to read; omitted reads the newest revision.
 * @returns the stored definition, or `undefined` when the project has none.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` for a non-positive revision.
 */
async readDefinition(projectId: ProjectId, revision?: number): Promise<DefinitionRecord | undefined>

/**
 * Store a new definition revision and refresh the registry hint.
 *
 * The revision is computed and inserted inside one `BEGIN IMMEDIATE` batch, so
 * concurrent writes get distinct consecutive revisions. The registry hint is
 * refreshed afterwards: a registry failure surfaces to the caller even though
 * the new revision is durable.
 * @param projectId - registered project to write.
 * @param document - complete definition document text.
 * @returns the revision number the document was stored under.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty document.
 */
async writeDefinition(projectId: ProjectId, document: string): Promise<number>

/**
 * Every run recorded for one project, newest first.
 * @param projectId - registered project to read.
 * @returns the run records.
 */
async listRuns(projectId: ProjectId): Promise<RunRecord[]>

/**
 * Every outbox event of one attempt, in event order.
 * @param projectId - registered project to read.
 * @param attemptId - attempt whose events are read.
 * @returns the stored events, acknowledged or not.
 */
async listOutbox(projectId: ProjectId, attemptId: AttemptId): Promise<OutboxRecord[]>

/**
 * Stage one outbox event for a later replay into a session log.
 *
 * `(attemptId, eventSeq)` is the idempotency key: repeating an append returns
 * the row already stored, including a previous acknowledgement, instead of
 * writing a duplicate.
 * @param projectId - registered project to write.
 * @param attemptId - attempt the event belongs to; it must be recorded first.
 * @param eventSeq - per-attempt event sequence.
 * @param payload - event payload text.
 * @returns the stored event.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty payload
 * or a negative sequence, and `unknown-attempt` when the attempt is not recorded.
 */
async appendOutbox( projectId: ProjectId, attemptId: AttemptId, eventSeq: number, payload: string, ): Promise<OutboxRecord>

/**
 * Acknowledge one staged outbox event.
 * @param projectId - registered project to write.
 * @param attemptId - attempt the event belongs to.
 * @param eventSeq - per-attempt event sequence.
 * @returns `true` when this call acknowledged the event, `false` when it was
 * absent or already acknowledged.
 */
async markAcked(projectId: ProjectId, attemptId: AttemptId, eventSeq: number): Promise<boolean>

/**
 * Run one synchronous body against one project's connection, inside one
 * `BEGIN IMMEDIATE` batch and serialized with every other write of that
 * database.
 *
 * This is how a consumer that owns its own rows — the workflow scheduler
 * writes runs, activations, attempts, artifacts, and the outbox together —
 * keeps one writer connection per database instead of opening a second one.
 * The body must be synchronous: an `await` inside it would hold the write
 * lock across unrelated work.
 * @param projectId - registered project whose connection the body uses.
 * @param body - statements to run; returning normally commits, throwing rolls back.
 * @returns the body's result after the commit.
 * @throws {@link WorkflowProjectStoreError} `invalid-project-id` or `project-not-found`,
 * and the body's own error after the batch rolled back.
 */
async transact<T>(projectId: ProjectId, body: (db: DatabaseSync) => T): Promise<T>

/**
 * Close every open connection and refuse further work. Idempotent.
 * @returns resolution once every queued write settled and every handle closed.
 */
async close(): Promise<void>
```

Source: [`packages/workflow/project-store/src/index.ts`](../../packages/workflow/project-store/src/index.ts)

<a id="ctxmwfpythonrunner--pythonrunner"></a>

### `ctx.mwfPythonRunner` — `PythonRunner`

Runs node functions on a host Python interpreter.

One service instance owns the `.venv` serialization of every project it touches and the termination bindings of the platform it runs on; it holds no other state, so a disposed instance leaves nothing behind.

```ts cordis-catalog
/**
 * Resolve the interpreter one request runs with.
 *
 * The caller's explicit path wins, then an existing project `.venv`, then the
 * configured `interpreterPath`, then a probe of the platform launchers.
 * @param request - explicit path and project directory; both optional.
 * @returns the validated interpreter.
 * @throws {@link PythonRunnerError} `python/not-found`, `python/unsupported-version`, or `python/free-threaded`.
 */
async resolveInterpreter(request: ResolveInterpreterRequest = {}): Promise<InterpreterSpec>

/**
 * Ensure the project's `.venv` exists and return its interpreter.
 *
 * Concurrent calls for the same project serialize, so the second call
 * observes the first creation instead of starting another one.
 * @param projectDir - project directory that owns the environment.
 * @returns absolute path of the environment's interpreter.
 * @throws {@link PythonRunnerError} `project/path-too-long`, `venv/create-failed`, or an interpreter failure.
 */
async ensureVenv(projectDir: string): Promise<string>

/**
 * Install requirements into the project's `.venv`, creating it when missing.
 *
 * Every installation is `--only-binary=:all:`, so a package that publishes no
 * wheel for this platform fails here with pip's own diagnostic instead of
 * failing later inside a node.
 * @param projectDir - project directory that owns the environment.
 * @param requirements - requirement specifiers; an empty list installs nothing.
 * @returns the pip exit facts, with `ok: false` and the pip tail on failure.
 * @throws {@link PythonRunnerError} `project/path-too-long`, `venv/create-failed`, or an interpreter failure.
 */
async installRequirements(projectDir: string, requirements: readonly string[]): Promise<InstallRequirementsResult>

/**
 * Run one node function and return its JSON value or its structured failure.
 *
 * The source is written to `nodes/<nodeId>/node_main.py` beside a generated
 * wrapper, which the resolved interpreter starts with `-X utf8` in the node's
 * own directory. Inputs arrive on stdin as UTF-8 JSON. On the deadline or an
 * abort the whole process tree is terminated.
 * @param request - project, node, source, inputs, limits, environment, and abort signal.
 * @returns the node's value or the failure, with captured logs and exit facts.
 * @throws {@link PythonRunnerError} `project/path-too-long`, `node/invalid-id`, or an interpreter failure;
 * an aborted run refuses with the signal's reason instead.
 */
async runNode(request: RunNodeRequest): Promise<RunNodeResult>
```

Source: [`packages/workflow/python-runner/src/index.ts`](../../packages/workflow/python-runner/src/index.ts)

<a id="ctxmwfscheduler--workflowscheduler"></a>

### `ctx.mwfScheduler` — `WorkflowScheduler`

The workflow scheduler service.

One instance owns the executor registrations, the per-run in-flight abort controllers, and the configuration every call reads; the durable state it schedules from stays in the project database.

```ts cordis-catalog
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
registerExecutor(executor: NodeExecutor): () => void

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
async createRun(request: CreateRunRequest): Promise<CreateRunResult>

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
async tick(request: RunRequest): Promise<TickResult>

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
async step(request: ActivationRequest): Promise<TickResult>

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
async pause(request: RunRequest): Promise<RunView>

/**
 * Allow a paused run to continue.
 * @param request - project and run to resume.
 * @returns the run as it now reads.
 * @throws {@link WorkflowSchedulerError} `scheduler/run-state-invalid` unless the run is paused.
 */
async resume(request: RunRequest): Promise<RunView>

/**
 * Cancel one run and every activation it has not finished.
 *
 * Committed results stay readable; a result that arrives after the abort is
 * stale and commits nothing.
 * @param request - project and run to cancel.
 * @returns the run as it now reads.
 * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` or `scheduler/run-state-invalid`.
 */
async cancel(request: RunRequest): Promise<RunView>

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
async retry(request: ActivationRequest): Promise<RetryResult>

/**
 * Recover one project after a backend restart.
 *
 * Every attempt still marked running becomes `interrupted`, its activation
 * returns to `pending`, and every running run is parked in `paused`; a human
 * (or the coordinator) then resumes or retries. The pass repairs no Session
 * tail: resuming a node's own conversation is the node executor's job.
 * @param request - project to reconcile.
 * @returns the interrupted attempts and the parked runs.
 * @throws {@link WorkflowSchedulerError} `scheduler/closed` after disposal.
 */
async reconcile(request: ReconcileRequest): Promise<ReconcileResult>

/**
 * One run as it reads now.
 * @param request - project and run to read.
 * @returns the run, or `undefined` when the project holds no such run.
 * @throws {@link WorkflowSchedulerError} `scheduler/closed` after disposal.
 */
async getRun(request: RunRequest): Promise<RunView | undefined>

/**
 * Every activation of one run, in creation order.
 * @param request - project and run to read.
 * @returns the activations.
 * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` for an unknown run.
 */
async listActivations(request: RunRequest): Promise<ActivationView[]>

/**
 * Attempts of one run, oldest first.
 * @param request - project and run to read, optionally narrowed to one activation.
 * @returns the attempts.
 * @throws {@link WorkflowSchedulerError} `scheduler/run-not-found` for an unknown run.
 */
async listAttempts(request: RunRequest & { readonly activationId?: ActivationId }): Promise<AttemptView[]>
```

Source: [`packages/workflow/scheduler/src/index.ts`](../../packages/workflow/scheduler/src/index.ts)

<a id="ctxworkflowengine--workflowengine-abstract-seam"></a>

### `ctx.workflowEngine` — `WorkflowEngine` (abstract seam)

Workflow Service Definition contract. Invalid requests throw before publication; a live run is holder-owned, its result never rejects, and disposal waits for script and child cleanup. Lifecycle listener failures are contained, and `workflow/end` fires exactly once as the result settles.

```ts cordis-catalog
/**
 * Parse and execute a workflow script.
 * @param request - the script, its `args`, the parent agent, and an
 *   optional cancel signal.
 * @returns the live run; its `result` resolves when the script settles.
 */
abstract start(request: WorkflowStartRequest): WorkflowRun
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflow-events"></a>

### `workflow/*` events

<a id="workflowagent-end--emit"></a>

#### `workflow/agent-end` — emit

One `agent()` call settled (clean result, child failure, or run cancellation). Paired with Events['workflow/agent-start'] by `agent.seq`, exactly once per started call on every stop path — on an engine termination path the end is engine-synthesized with outcome `'cancelled'`.

```ts cordis-catalog
/**
 * One `agent()` call settled (clean result, child failure, or run
 * cancellation). Paired with {@link Events['workflow/agent-start']} by
 * `agent.seq`, exactly once per started call on every stop path — on an
 * engine termination path the end is
 * engine-synthesized with outcome `'cancelled'`.
 * @param info - the run's identity snapshot.
 * @param agent - the call identity plus its outcome.
 * @mode emit
 */
'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-start--emit"></a>

#### `workflow/agent-start` — emit

One `agent()` call established a published child run. Paired with Events['workflow/agent-end'] by `agent.seq`. A call that never receives a published run from the provider emits neither event in this pair.

```ts cordis-catalog
/**
 * One `agent()` call established a published child run. Paired with
 * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
 * receives a published run from the provider emits neither
 * event in this pair.
 * @param info - the run's identity snapshot.
 * @param agent - the call's sequence number, label, phase, and child id.
 * @mode emit
 */
'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowend--emit"></a>

#### `workflow/end` — emit

A workflow run settled (any stop reason). Fired when WorkflowRun.result resolves. Paired with Events['workflow/start'].

```ts cordis-catalog
/**
 * A workflow run settled (any stop reason). Fired when
 * {@link WorkflowRun.result} resolves. Paired with
 * {@link Events['workflow/start']}.
 * @param info - the run's identity snapshot.
 * @param result - the outcome data (stop reason, error, agent count) —
 *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
 * @mode emit
 */
'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowlog--emit"></a>

#### `workflow/log` — emit

The script emitted a narration line (a `log(message)` call).

```ts cordis-catalog
/**
 * The script emitted a narration line (a `log(message)` call).
 * @param info - the run's identity snapshot.
 * @param message - the logged message, verbatim.
 * @mode emit
 */
'workflow/log'(info: WorkflowRunInfo, message: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowphase--emit"></a>

#### `workflow/phase` — emit

The script entered a phase (a `phase(title)` call) — progress grouping for observers; no execution semantics.

```ts cordis-catalog
/**
 * The script entered a phase (a `phase(title)` call) — progress grouping
 * for observers; no execution semantics.
 * @param info - the run's identity snapshot.
 * @param title - the phase title, verbatim.
 * @mode emit
 */
'workflow/phase'(info: WorkflowRunInfo, title: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowstart--emit"></a>

#### `workflow/start` — emit

A workflow run started — the script's meta block validated, the body about to execute. Paired with Events['workflow/end'].

```ts cordis-catalog
/**
 * A workflow run started — the script's meta block validated, the body
 * about to execute. Paired with {@link Events['workflow/end']}.
 * @param info - the run's identity snapshot (id + meta).
 * @mode emit
 */
'workflow/start'(info: WorkflowRunInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)
<!-- END GENERATED cordis-surface -->

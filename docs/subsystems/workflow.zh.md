# 工作流

[English](workflow.md) | 中文

工作流 seam 允许 agent（智能体）运行由模型编写、会启动 subagent 的编排脚本。与 [subagent](subagent.zh.md) 一样，它是**一项可选能力**，不属于 agent loop，因此其类型和操作记录在此处，而非 [core.md](core.zh.md)。与 bash 一样，每个上下文只允许一个引擎实现提供 `ctx.workflowEngine`；没有命名提供方注册表（第二个引擎通过插件配置替换第一个，而不与它同时运行）。

Service Definition：[mwf-workflow](../../packages/workflow/workflow)（`ctx.workflowEngine` 和下文词汇）。[mwf-workflow-ptc](../../packages/workflow/workflow-ptc)通过共享 Node PTC 进程运行时按调用 Session 的文件策略执行 VM 与辅助函数。消费方为 [mwf-tool-workflow](../../packages/workflow/tool-workflow) 和需显式启用的 [mwf-tool-ralph](../../packages/experimental/tool-ralph)。[工作流沙箱复用](../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md)负责执行选择；[动态工作流参考](../../packages/workflow/workflow/README.zh.md)负责脚本语义。

源码：浏览器安全词汇位于 [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)，Host 请求与活跃运行句柄位于 [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts)。

## 启动请求

本节定义调用方启动一次运行时提交的请求。普通工作流工具会根据模型的 `{ script, meta, args }` 调用和发起调用的 agent 构建该请求；专用消费方还可以为本次运行选择引擎级 `subagentProvider`，并将 `maxTotalAgents` 调低，但脚本无法观察或替换这两项策略。`meta` 与 `args` 是普通 JSON 数据；引擎会用 schema 校验 `meta`，并在任何工作开始前明确报错并拒绝无效数据。引擎绝不会通过对脚本文本求值来获取它们。`parent` 是必填字段——脚本启动的每个子 agent 都归属于它，cwd、谱系与深度通过 [subagent seam](subagent.zh.md) 传递。

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

## 工作流的身份标识：`WorkflowMeta`

作为数据附在启动请求上的身份块（工具的 `meta` 参数；字段词汇与 Claude Code 动态工作流的 meta 块一致）。`phases` 仅用于进度展示：`phase()` 调用与标题匹配，供观察者使用；不暗示任何执行结构。

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

## 终态结果：`WorkflowResult`

`WorkflowRun.result` 会兑现为一次运行的结果。`value` 是脚本的物化返回值——纯宿主域 JSON 数据（脚本无返回值时为 `null`）——仅在 `completed` 时有意义。`stopReason` 是封闭联合类型（由引擎定义；消费方可穷举）：`completed` | `cancelled` | `error`。非 `completed` 的原因在 `error` 中携带失败信息，消费方将其映射为 `isError` 工具结果，而非把部分输出当作成功上报。

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

## 活跃运行：`WorkflowRun`

消费方等待 `result`，可以在执行期间调用 `cancel`，且必须在每条路径上调用 `dispose`（资源释放）。`result` 绝不拒绝：脚本失败以 `stopReason: 'error'` 兑现，取消以 `'cancelled'` 兑现。PTC 引擎没有整体经过时间截止；取消时立即中止受管进程。资源释放按照各提供方约定等待进程与子 agent 清理，不另设工作流清理截止。

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

## 失败纪律：`WorkflowError.fatal`

脚本内部的钩子误用：错误参数、未知或延迟的 `agent()` 选项、超出[结构化输出子集](../../packages/core/tools/README.zh.md)的 schema、超出上限、seam 启动失败、取消，都会抛出 `fatal: true` 的 `WorkflowError`。`parallel()`/`pipeline()` 组合器对 fatal 错误直接重新抛出，而非将该项映射为 `null`：一个拼写错误的选项必须明确报错并终止脚本，绝不能消融为看似普通子 agent 失败的结果。逐项的 `null` 保留给子运行失败（非 `completed` 的 stop reason）和阶段内的普通脚本错误。

## 事件

`workflow/*` 事件（`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end`，见[事件目录](#cordis-surface)）是**仅供观察**的 emit，携带数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，而非活跃的 `WorkflowRun`，因此订阅者无法获得 `cancel`/`dispose`；`workflow/end` 刻意省略 result value（观察结果的监听器不得收到调用方 result 的可变别名）。每次 emit 对每个监听器隔离：订阅者抛出的异常会被记录到日志中而不会传播，也不会阻止后续注册的监听器收到事件；每个监听器收到自己的 payload 克隆，因此修改它既不会损坏引擎也不会影响其他监听器。这种隔离方式与 `subagent/start`/`subagent/end` 一致。

## 持久 Chat 记录

顶层 `mwf-tool-workflow` 消费方把展示事实投影到调用它的父 Session，同时不改变执行所有权。运行接受后写 `tool-workflow/run-start`，以 `runId + seq` 配对成员开始与结束，并且只在结果已取得且 dispose 完全停稳后写 `tool-workflow/run-end`。嵌套 transport 调用不写记录。第一次 append 失败会禁用本运行后续写入，因此日志保持为空或合法连续前缀，工具结果不变。

该记录协议规定：每个运行只有一个 start，成员序号为正且唯一，成员 end 必须配对，仍有开放成员时不能结束运行，运行结束后不能继续更新。日志尾部缺少成员 end 或 run end 是有效的中断证据，不是损坏。

`mwf-client-ui-workflow-run` 通过 Conversation Node 引擎把四类事件折叠为一个 `workflow-run` Chat 节点，以 run-start 序号锚定在原工作流工具节点之后。阶段组只来自真正开始过的成员，并保留精确字符串，包括字段缺省与 `''` 的区别。Location 关闭时，缺失终点会显示为已中断。[界面包 README](../../packages/client/ui-workflow-run/README.zh.md)负责定义 disclosure、状态与同父本地导航行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmwfagentexecutor--agentexecutor"></a>

### `ctx.mwfAgentExecutor` — `AgentExecutor`

Runs workflow agent nodes for the scheduler.

One instance owns one executor registration for the `agent` kind, which is an effect: disposing the plugin unregisters it, so a replaced plugin never leaves a duplicate executor behind. It also owns `ctx.mwfNodeSessions`, the live session-to-attempt registry, in the same scope.

```ts cordis-catalog
/**
 * Run one activation's agent node.
 *
 * The stored definition revision is authoritative: the executor builds the
 * child Agent from that revision's node configuration, never from the
 * scheduler-supplied copy, so a run executes the composition the project
 * stored.
 * @param activation - the node, its iteration and attempt number, and the run's parameters.
 * @param inputs - the assembled input values, keyed by binding name.
 * @param signal - aborted when the run is paused or canceled.
 * @returns the completed value, or a structured failure.
 * @throws the abort reason when `signal` aborted, because that outcome is not a node failure.
 */
async execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult>
```

Source: [`packages/workflow/agent-executor/src/index.ts`](../../packages/workflow/agent-executor/src/index.ts)

<a id="ctxmwfnodesessions--nodesessionregistry"></a>

### `ctx.mwfNodeSessions` — `NodeSessionRegistry`

One record per live child Agent of the workflow agent executor.

```ts cordis-catalog
/**
 * Record the attempt one session runs for.
 *
 * A retained node resumes the same session for a later attempt, so binding an
 * existing session replaces its record: the newest attempt is the one that
 * drives it now.
 * @param record - the session and the attempt running it.
 * @returns nothing.
 */
bind(record: NodeSessionRecord): void

/**
 * The record of one session.
 * @param sessionId - child Agent's session identity.
 * @returns the attempt the session serves, or `undefined` when no attempt owns it.
 */
lookup(sessionId: SessionId): NodeSessionRecord | undefined

/**
 * Drop the record of one settled attempt.
 * @param sessionId - child Agent's session identity.
 * @returns nothing; an absent record is not an error.
 */
forget(sessionId: SessionId): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/workflow/agent-executor/src/node-sessions.ts`](../../packages/workflow/agent-executor/src/node-sessions.ts)

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

<a id="ctxmwfpythonexecutor--pythonexecutor"></a>

### `ctx.mwfPythonExecutor` — `PythonExecutor`

Runs workflow python nodes for the scheduler.

One instance owns one executor registration for the `python` kind, which is an effect: disposing the plugin unregisters it, so a replaced plugin never leaves a duplicate executor behind.

```ts cordis-catalog
/**
 * Run one activation's python node.
 *
 * The stored definition revision is authoritative for what the run executes:
 * the executor reads the revision the run was created from and takes the
 * node's source from it, so a scheduler-provided node object never supplies
 * code this run did not store.
 * @param activation - the node, its iteration and attempt number, and the run's parameters.
 * @param inputs - the assembled input values, keyed by binding name.
 * @param signal - aborted when the run is paused or canceled.
 * @returns the node's JSON value, or a structured failure.
 * @throws the abort reason when `signal` aborted, because that outcome is not a node failure.
 */
async execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult>
```

Source: [`packages/workflow/python-executor/src/index.ts`](../../packages/workflow/python-executor/src/index.ts)

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

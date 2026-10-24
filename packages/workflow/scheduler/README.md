---
description: "Turns a stored workflow definition into a durable run on the host: which activations are ready, which executor runs them, how many run at once, what a failure retries, when a loop is exhausted, and what a committed attempt writes into the project database."
kind: "package-reference"
---

# @metaworkflow/workflow-scheduler

English | [中文](README.zh.md)

## Summary

`ctx.mwfScheduler` turns one stored definition revision into a run that can be paused, resumed, stepped, retried, canceled, and recovered after a restart. It decides which activations are ready, which executor runs a node, how many run at once, what a failure retries, and when a loop is exhausted. Every decision lands in the project database in one transaction with the attempt's result, its outbox event, and the activations it routes to. Executors are a seam: this package ships none.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `@metaworkflow/workflow-project-store` in a Host composition and register one executor per node kind; it is driven through `ctx.mwfScheduler`.

### When to choose it

Choose it when workflow nodes must run as one resumable run over a stored graph rather than as a single call, and when the caller owns what a node actually does. It ships no Python or Agent executor: the scheduler imports neither `@metaworkflow/workflow-python-runner` nor any Agent package, so a composition registers the kinds it runs and a ready activation whose kind has no executor fails its run with `scheduler/executor-missing` instead of waiting. Do not use it as a general job queue — it schedules one project's workflow graph and writes only workflow rows.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-scheduler'
```

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrent` | `4` | Node executions one run may have in flight |
| `maxAttempts` | `2` | Attempts one activation may spend before it fails |

The generated [configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-scheduler) is the exhaustive source for every accepted field.

### Service API

| Method | Behavior |
|---|---|
| `createRun({ projectId, definitionRevision, params? })` | Validates the revision, writes the run and its entry activation in one transaction, and returns `{ runId }` |
| `tick({ projectId, runId })` | Advances the run until nothing else can start, at most `maxConcurrent` at a time |
| `step({ projectId, runId, activationId })` | Executes one ready activation, then parks the run in `paused` |
| `pause` / `resume` / `cancel({ projectId, runId })` | Stops scheduling and aborts in-flight attempts, reopens a paused run, or cancels every unfinished activation |
| `retry({ projectId, runId, activationId })` | Reopens a failed, canceled, or waiting activation as a new attempt and returns its id |
| `resumeActivation({ projectId, runId, activationId, decision? })` | Wakes a waiting activation with the answer it asked for, stores that answer beside its rows, and advances the run |
| `reconcile({ projectId })` | Marks running attempts `interrupted`, returns their activations to `pending`, parks running runs, and reports what it changed — waiting activations keep their state and are reported separately |
| `getRun` / `listActivations` / `listAttempts` | Read the run, its activations, and its attempts back |
| `registerExecutor(executor)` | Registers the executor for one node kind and returns the disposer |

`createRun`, `step`, `resumeActivation`, and `retry` reject with a typed `WorkflowSchedulerError`: `scheduler/definition-unavailable`, `scheduler/definition-invalid`, `scheduler/activation-not-found`, `scheduler/activation-not-ready`, `scheduler/activation-not-retryable`, `scheduler/activation-not-resumable`, `scheduler/run-not-found`, `scheduler/run-state-invalid`, `scheduler/duplicate-executor`, or `scheduler/closed`. A node's own failure is not an exception: it is committed, reported in `TickResult.diagnostics`, and fails the run.

### The executor seam

```ts
import type { NodeActivation, NodeInputs, NodeResult } from '@metaworkflow/workflow-scheduler'

interface NodeExecutor {
  readonly kind: 'python' | 'agent'
  execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult>
}
```

`NodeResult` is `{ status: 'succeeded', value, artifacts? }`, `{ status: 'failed', error, retryable }`, or `{ status: 'waiting', requestId }`. A successful result is the JSON value routing reads and later activations consume; `artifacts` publishes files under stable names. A retryable failure spends another attempt while the budget lasts. A waiting result names the decision the node asked for: the attempt and activation become `waiting`, the execution slot is released, no result is committed, and `resumeActivation` continues the node with the answer.

A waiting activation never satisfies a join. An `all` join whose declared predecessor is still waiting does not fire, so its target starts only after the resumed activation succeeds; a `waiting` attempt is also not an interrupted one, so a recovery pass leaves it exactly as it was.

An executor must observe `signal` and settle: pausing, canceling, or disposing the service aborts it, and a result that arrives afterwards is stale.

### Committed outcomes

One successful attempt commits its result, its activation transition, the artifacts it published, the activations its routing created or extended, and one `session_outbox` row in a single `BEGIN IMMEDIATE` batch. `(attempt_id, event_seq)` is the outbox idempotency key, and the payload is `{ type: 'scheduler/attempt-result', … }` — a delivery payload, not a `SessionEventMap` member. A write that fails rolls the whole batch back, so no half-applied outcome survives.

A result is refused as `scheduler/stale-result` when its attempt is no longer running or the run moved to another definition revision. That is what keeps a paused or canceled attempt from publishing.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One state change is one transaction.** `ctx.mwfProjectStore.transact` runs the scheduler's rows on the store's single writer connection, so the store keeps owning connections, serialization, and rollback.
- **Readiness is computed, not stored.** An activation is ready when it is pending, its frozen incoming set has succeeded, and — for an `all` join — no declared predecessor of this round is still open. Join state therefore never needs its own column or repair path.
- **Iteration is part of identity.** An activation is `(runId, nodeId, iteration)`; a loop edge enters `source + 1`, and an incoming reference carries the iteration it recorded, so an older round never satisfies a newer join.
- **The graph is pinned.** A run executes exactly the revision it was created from, and a commit whose run moved elsewhere is refused.
- **Slots are per run.** One pass dispatches at most `maxConcurrent` executions and admits the next ready activation as each settles; a waiting node gives its slot back.

### Scheduling loop

A pass reads the run and its activations, starts every ready activation the slot budget allows, and waits for one in-flight execution before re-evaluating. It stops when the run settles or pauses, or when only waiting work remains. A single step names one activation, executes it, then parks the run. Concurrent passes on one run are serialized.

### Failure handling

An input binding that resolves to nothing fails its activation with `scheduler/input-missing`; a routing failure (`routing/ambiguous`, `routing/no-match`) fails the run with its diagnostic; a loop that would exceed `maxIterations` fails the run with `scheduler/loop-exhausted`; a node failure retries while it is retryable and the attempt budget lasts, then fails the activation and the run. A failed branch never blocks a sibling that already started, and every committed result stays readable.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin, config, the service methods, and the scheduling loop |
| [`src/schedule.ts`](src/schedule.ts) | Readiness, iteration, routing reasons, and settlement |
| [`src/inputs.ts`](src/inputs.ts) | Input assembly from results, run parameters, and artifacts |
| [`src/records.ts`](src/records.ts) | Row statements over the project database |
| [`src/executors.ts`](src/executors.ts) | One executor per node kind |
| [`src/errors.ts`](src/errors.ts) | Typed refusals |
| [`src/types.ts`](src/types.ts) | Requests, views, the executor seam, and diagnostics |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam the scheduler plugs into.
- [Workflow project store](../project-store/README.md) — the database every run lives in.
- [Workflow definition](../definition/README.md) — the document, routing, and join arithmetic this package executes.
- [Python node runner](../python-runner/README.md) — the executor the next stage registers for `python` nodes.
- [Generated configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-scheduler) — every accepted field.

-----

<a id="model-experience"></a>
## Model Experience

None, as the scheduler commits workflow rows and registers no prompt, tool, or session event.

#### KV Cache effect

No model request is assembled here, so no cached prefix changes; an executor that reaches a model owns any resulting invalidation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

A composition that registers no executor fails every activation with `scheduler/executor-missing`; the Python and Agent executors are separate packages mounted beside this one.

- **No backoff** — a retryable failure retries immediately; the attempt budget is the only limiter.
- **An answer resumes one activation** — `resumeActivation` names one waiting activation by id; a graph with several waiting nodes needs one call per node, because a re-answer of the same work would run a node whose question is no longer the one answered.
- **A decision outlives the answering process only as input** — the answer is stored beside the activation's rows and handed to the next attempt, and it is cleared when an attempt commits; a scheduler process that dies after the answer was committed still resumes with it, but nothing replays an answer whose activation was canceled in between.
- **A first-success target can wait for a missing input** — firing on the first committed branch means an input bound to another, still-open branch resolves to nothing and fails that activation with `scheduler/input-missing`.
- **One revision per run** — a run never re-reads its definition, so editing a workflow mid-run is refused as `scheduler/stale-result` rather than applied to the affected activations.
- **No Session repair** — `reconcile` reports interrupted attempts and parks runs; resuming a node's own conversation is the executor's job.
- **Artifacts are references** — a published artifact is recorded by name, version, and relative path; the scheduler neither writes nor verifies the file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The suites drive the service through fake executors over a real temporary database, so every case is deterministic: a deferred executor holds an activation in flight while the test pauses, cancels, reconciles, or moves the run's revision. `tests/transaction.spec.ts` injects an outbox write failure with a SQLite trigger to prove the commit rolls back as one batch.

</details>

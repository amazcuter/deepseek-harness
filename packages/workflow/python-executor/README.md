---
description: "Runs workflow python nodes for the scheduler: registers the python node kind, reads each run's stored definition revision for the node source, prepares the project environment, and reports one JSON value or a structured failure."
kind: "package-reference"
---

# @metaworkflow/workflow-python-executor

English | [中文](README.zh.md)

## Summary

`ctx.mwfPythonExecutor` connects the workflow scheduler to the host Python runner. The scheduler owns readiness, retries, loops, and durable rows; this plugin supplies the `python` node kind, so one ready activation becomes one real child process. Per call it reads the run's stored definition revision for the node source, resolves the project working directory, prepares the project environment, and reports the node's JSON value or a structured failure. It keeps no scheduling state and writes none.

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

Mount it beside `@metaworkflow/workflow-project-store`, `@metaworkflow/workflow-scheduler`, and `@metaworkflow/workflow-python-runner` in a Host composition. It registers itself; no caller drives it directly.

### When to choose it

Choose it when a stored definition's `python` nodes must actually execute, and when the scheduler's retries, loop bounds, and restart recovery must apply to them. Do not mount it without the python runner or the project store: the executor injects all three services and activates only when they exist. Do not use it to run untrusted code in a sandbox — a node runs with the host user's authority, as the runner documents — and do not use it as a general job runner, because it executes one activation the scheduler already decided to start.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-python-executor'
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | runner default | Wall-clock deadline of one node run; omitted leaves the deadline to `@metaworkflow/workflow-python-runner` |

The generated [configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-python-executor) is the exhaustive source for every accepted field.

### Service API

| Method | Behavior |
|---|---|
| `execute(activation, inputs, signal)` | Reads the activation's stored definition revision, opens the project, ensures its `.venv`, runs the node, and returns `{ status: 'succeeded', value }` or `{ status: 'failed', error, retryable }` |

The scheduler reaches this method through the registered `python` executor; the public method exists so a caller can test one activation without driving a run. Abort is the one rejection: an aborted signal reports the abort instead of a node failure, because a paused or canceled run must not record one.

### What one execution reports

| Runner outcome | Result |
|---|---|
| `ok: true` | `succeeded` with the node's JSON value |
| `ok: false`, `node/timeout` | `failed` with that code and `retryable: true` — the one failure another attempt may still fit |
| `ok: false`, any other node code | `failed` with the runner's code and `retryable: false`; the captured stderr follows the message |
| environment rejection | `failed` with the runner's own code (`python/not-found`, `venv/create-failed`, …) |
| stored revision missing or unparsable | `failed` with `python/definition-unavailable` |
| stored revision has no python node under that id | `failed` with `python/node-unavailable` |
| project working directory cannot be opened | `failed` with `python/project-unavailable` |
| anything else | `failed` with `python/executor-failed` |

A failure never escapes as an exception, so one bad node cannot abort a run's other work; the scheduler commits the failure and decides what happens next.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service holds two things: its resolved configuration and one `ctx.effect` registration with the scheduler. Disposing the plugin unregisters the `python` kind, so a replaced composition never leaves a duplicate executor behind.

**Definition authority.** The executor does not run the node object it was handed. It reads the revision the run was created from (`activation.definitionRevision`) and takes that revision's `config.source`, so the node code a run executes is the code the project stored. A revision that is gone, unparsable, or silent about the node is a structured failure, not a fallback to the activation's copy.

**Working directory.** The project record's `path` is the directory the runner receives: node files land in `<path>/nodes/<nodeId>/`, and the project's `.venv` sits beside them. Every activation of every run in that project resolves the same directory.

**Lifetime.** One call is one `runNode`; the executor keeps no per-run state, never retries, and never writes a scheduling row. The scheduler's abort signal passes straight through, and the runner terminates the child's process tree.

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin, executor registration, outcome mapping |
| `src/types.ts` | Configuration and failure codes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam these services belong to.
- [Workflow scheduler](../scheduler/README.md) — who dispatches the activations this plugin runs.
- [Python runner](../python-runner/README.md) — interpreter resolution, `.venv`, and the node protocol.
- [Workflow project store](../project-store/README.md) — where definition revisions and project directories live.
- [Generated configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-python-executor) — every accepted field.

-----

<a id="model-experience"></a>
## Model Experience

None, as the executor adapts scheduler activations to the python runner and registers no prompt, tool, or session event.

#### KV Cache effect

No model request is assembled here, so no cached prefix changes; the scheduler and the consumers that render a node's value own any resulting invalidation.

## Known Limitations and Deferred Work

- **No artifact publication** — a node's returned value is committed, but files it writes are not published as `NodeArtifact` records yet, so an `artifact` input binding has nothing to read from this executor.
- **One `.venv` per project** — the executor ensures the project environment before every run but never installs requirements; a project whose nodes import third-party packages needs `installRequirements` from another caller.
- **Sequential preparation** — environment preparation happens inside the activation, so the first node of a fresh project pays the `.venv` creation cost before its own deadline starts counting.
- **No sandbox** — a node runs with the host user's authority; confinement stays with `@metaworkflow/sandbox-local` and is not wired here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The real-interpreter suites skip on a host without a supported launcher and reuse one temporary home, so `.venv` creation is paid once per suite. The restart suite reconciles a run while its node is still sleeping: the recovery pass does not abort the child, which is what makes the late result a stale-result test rather than a cancellation test.

</details>

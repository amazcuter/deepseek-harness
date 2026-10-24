---
description: "One persistent coordinator Session per workflow project: the Session identity it records, the tools that answer and list decisions, the events a UI subscribes to, and how answering resumes a waiting node."
kind: "package-reference"
---

# @metaworkflow/workflow-coordinator

English | [中文](README.zh.md)

## Summary

`ctx.mwfCoordinator` gives each workflow project one persistent coordinator Session: a conversation that plans the project's workflow, answers the decisions its nodes ask, and reports the project's runs and activations. The Session records its identity in the project database, so the next process resumes the same conversation. Its tools answer a pending decision, list what still waits, and report project state; answering one resumes the waiting activation through the scheduler. Agent nodes parent their conversations on this Session, and both events stay out of the Session log, so a UI subscribes instead of polling.

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

Mount it beside the project store and the scheduler in a Host composition; nothing else is required, and the service opens a project's Session on first use.

### When to choose it

Choose it when workflow nodes must escalate decisions to a human-facing conversation that outlives any single node turn, and when that conversation needs the project's state and the ability to resume work. Avoid it when every node can settle from its own inputs: the coordinator is a real Agent Session and its model cost is per coordinator turn, not per node.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-coordinator'
```

The plugin accepts no configuration: its Session model route comes from the deployment default model, and every project gets the same composition.

### Service API

| Method | Behavior |
|---|---|
| `ensureSession(projectId)` | Opens the project's coordinator Session: creates and records one on first use, resumes the recorded one afterwards |

### Tools the coordinator Session gains

| Tool | Behavior |
|---|---|
| `answer_decision({ requestId, answer })` | Records the answer, resumes the waiting activation through `ctx.mwfScheduler.resumeActivation`, and announces the answer. An unknown id is refused, and a repeated answer reports the recorded one without changing what the node received |
| `list_pending_decisions()` | Lists every unanswered request of the project, oldest first, with the question and the options the node proposed |
| `get_project_state()` | Reports the project, every run with its status and reason, and the newest run's activations with their attempt counts |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

**One Session per project.** The Session identity lives in the project database's `schema_meta` row under `coordinator/session`, the compatibility record the store already uses for per-project side tables. The first `ensureSession` creates an Agent under a fresh id and records it before answering anything; every later call resumes it, so the coordinator's plan survives a restart, a plugin reload, and a different backend process. Concurrent callers share one in-flight open, so a project never gets two coordinators.

**Scope.** The Session's tools and prompt section are registered in its own Agent scope during creation. They close over the project id, so a coordinator can only answer its own project's decisions, and no other Agent sees them.

**Answering.** `answer_decision` asks the store for the first answer, then resumes the activation with it. The store's first answer is authoritative: a repeated call reports the recorded answer instead of replacing it, and an unknown request id writes nothing. The resumed attempt receives the answer as an input, so the node continues a conversation that knows what was decided.

**Events.** `workflow/decision-answered` carries the project, run, activation, request id, answer, and the run status after the resume. The node executor emits its paired `workflow/decision-requested`; neither event is a `SessionEventMap` member.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | The service, Session opening and resumption, the prompt, and the answered event |
| [`src/tools.ts`](src/tools.ts) | The three model-facing tools and their project binding |
| [`src/session-store.ts`](src/session-store.ts) | The `schema_meta` record that makes one Session persistent |
| [`src/types.ts`](src/types.ts) | Pending decisions, project state, and the answered event payload |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow project store](../project-store/README.md) — the decision rows and the `schema_meta` record this package reads and writes.
- [Workflow scheduler](../scheduler/README.md) — `resumeActivation` and the `waiting` activation an answer wakes.
- [Workflow agent executor](../agent-executor/README.md) — the producer of `workflow/decision-requested` and the node conversations this Session parents.
- [Decision tool](../tool-request-decision/README.md) — the tool a node asks its question through.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam these services belong to.

-----

<a id="model-experience"></a>
## Model Experience

### Coordinator prompt section

#### What the model sees

One section at the deployment-persona order naming the project, its working directory, and the coordinator's responsibilities: design and repair the project's workflow, answer the decisions its nodes ask, report state, repair nodes itself, and leave structural workflow changes to an explicit user request. The section is not interpolated, so a project title containing braces stays literal text.

#### Token effect

Fixed per coordinator request: the section is re-rendered on every turn of the conversation.

#### KV Cache effect

Append-only. The project title and path are stable for one project, so the section extends an already-reusable prefix instead of replacing it.

### Coordinator tools

#### What the model sees

Three declarations — `answer_decision`, `list_pending_decisions`, and `get_project_state` — each naming the decision lifecycle in the coordinator's terms. `answer_decision` documents that the answer becomes the waiting node's next input and that an answer is recorded once.

#### Token effect

Conditional. The declarations are present on every coordinator request; the result text of `list_pending_decisions` grows with the number of pending questions.

#### KV Cache effect

Append-only within one coordinator conversation; the declarations are stable, and pending lists are turn-local content after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The coordinator is a conversation, not a scheduler: it starts no work of its own.

- **No workbench surface yet** — nothing in the shipped Web surface drives the coordinator's turns. The service and its events exist so the workbench in the next stage subscribes and writes messages into the same Session.
- **One Session per project, unbounded history** — the conversation is never compacted by this package, so a long project relies on the deployment's compaction policy.
- **The coordinator cannot cancel work** — it answers decisions and reports state; pausing, canceling, or retrying a run belongs to the scheduler and its caller.
- **An answer is delivered once** — a node that asks again after resuming creates a new request; the earlier answer is history, not a fallback.
- **A refused resume is reported, not repaired** — `answer_decision` records the answer and then resumes the activation; when the scheduler refuses because the activation stopped waiting, the tool reports that refusal and the node is reachable through the scheduler's own `retry`, which delivers no answer.
- **Project deletion is not coordinated** — removing a project leaves its Session log behind, because the Session backend owns that file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Suites mount the whole product ordering — persistence, the loop, the store, the scheduler, the executor, then this plugin — and drive real child Agents with a scripted transport. A decision is asked by an agent node, answered by a coordinator turn that calls `answer_decision`, and the run is asserted to settle, so the answer path is covered end to end rather than through the tool in isolation. The scripted transport routes each model call to a per-role queue, because answering resumes the node while the coordinator's own call is still in flight.

</details>

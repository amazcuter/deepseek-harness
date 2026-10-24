---
description: "Runs workflow agent nodes for the scheduler: registers the agent node kind, composes one constrained DSH child Agent per activation from the node's instructions, tool allow list, memory policy, and completion tool, and commits the structured result that tool accepted."
kind: "package-reference"
---

# @metaworkflow/workflow-agent-executor

English | [中文](README.zh.md)

## Summary

`ctx.mwfAgentExecutor` connects the workflow scheduler to the Agent runtime. The scheduler owns readiness, retries, loops, and durable rows; this plugin supplies the `agent` node kind, so one ready activation becomes one child Agent composed from the node's stored configuration. The child receives the node's instructions as its persona, a tool allow list that selects capabilities without deriving permissions, a memory policy that decides whether it continues an earlier conversation, and a completion tool whose `value` parameter is the node's `outputSchema`. The node's result is whatever that tool recorded, and plain assistant text is never a result.

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

Mount it beside `@metaworkflow/workflow-project-store` and `@metaworkflow/workflow-scheduler` in a Host composition that already composes the Agent runtime: the Agent registry, a durable Session backend, the prompt and tool registries, and the deployment's default model. It registers itself; no caller drives it directly.

### When to choose it

Choose it when a stored definition's `agent` nodes must actually run as Agents, and when the scheduler's retries, loop bounds, and restart recovery must apply to them. Do not mount it without a durable Session backend: a `retained` node resumes the conversation it recorded, so a backend that cannot reload a session turns the node's next activation into `agent/session-unavailable`. Do not use it to confine an untrusted definition — a child Agent runs with the host user's authority through whatever tools the deployment registers — and do not use it as a general Agent runner, because it runs exactly one activation the scheduler already decided to start.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-agent-executor'
```

| Field | Default | Meaning |
|---|---|---|
| `turnTimeoutMs` | `600000` | Wall-clock deadline of one node turn; an exceeded deadline cancels the turn and reports a retryable `agent/timeout` |

The generated [configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-agent-executor) is the exhaustive source for every accepted field.

### Service API

| Member | Behavior |
|---|---|
| `execute(activation, inputs, signal)` | Reads the run's stored definition revision, opens the project directory, composes the child Agent, drives one turn, and returns `{ status: 'succeeded', value }` or `{ status: 'failed', error, retryable }` |
| `nodeSessions` | The `ctx.mwfNodeSessions` registry: which attempt each running child Agent session serves |

The scheduler reaches `execute` through the registered `agent` executor; the public method exists so a caller can test one activation without driving a run. Abort is the one rejection: an aborted signal reports the abort instead of a node failure, because a paused or canceled run must not record one. `ctx.mwfNodeSessions` is registered in this plugin's own scope, so the completion tool and the executor share it by construction.

### What one execution reports

| Outcome | Result |
|---|---|
| The completion tool accepted a value | `succeeded` with that value |
| The turn ended without a completion | `failed` `agent/completion-missing`, retryable |
| The loop ended the turn with an error | `failed` `agent/turn-failed`, retryable |
| The turn reached the model's output-token ceiling | `failed` `agent/turn-failed`, retryable |
| The turn was canceled outside this executor | `failed` `agent/canceled`, non-retryable |
| The deadline expired | `failed` `agent/timeout`, retryable |
| The node's tool allow list names a tool the deployment does not register | `failed` `agent/composition-failed`, non-retryable |
| The run, its revision, the node, or the project directory is gone | `failed` `agent/run-unavailable`, `agent/stale-activation`, `agent/definition-unavailable`, `agent/node-unavailable`, or `agent/project-unavailable`, non-retryable |
| The child Agent cannot be created or resumed | `failed` `agent/session-unavailable` |

A failure never escapes as an exception, so one bad node cannot abort a run's other work; the scheduler commits the failure and decides what happens next.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service holds three things: its resolved deadline, one `ctx.effect` registration with the scheduler, and the `mwfNodeSessions` registry it creates in its own scope. Disposing the plugin unregisters the `agent` kind and drops the registry, so a replaced composition never leaves a duplicate executor or a stale session record behind.

**Definition authority.** The executor does not run the node object it was handed. It reads the run's recorded revision, refuses an activation naming a different revision (`agent/stale-activation`), reads that revision's stored document, and takes the node's `config` from it. A revision that is gone, unparsable, or silent about the node is a structured failure, not a fallback to the activation's copy.

**Composition.** Creation and resume both run one scoped setup callback, so a resumed session is reconstituted exactly like a fresh one: the node's `instructions` become the `workflow:node-instructions` prompt section at the persona-prefix order with interpolation disabled, the completion tool and its instruction section are registered on the child's scope, and `tools.restrict({ allow })` limits the child to the node's tool names. The allow list only selects; it derives no permission, so a sandbox, approval, or model choice stays with the tools themselves. Because every registration belongs to the child's scope, one node's tool switches never reach another node, and disposing the child removes them.

**Model route.** A workflow definition carries no model of its own in this stage, so every child Agent uses the deployment's default selection (`ctx.agentDefaultModel`), including its optional reasoning effort.

**Memory.** `fresh` creates a session per activation and records nothing. `retained` reads the project's `schema_meta` compatibility row for this run and node; a recorded session is resumed through `ctx.agents.resume()`, and a first activation creates one and records it before the turn starts. The run is part of the key, so two runs of the same definition never share a conversation, and a loop iteration is not, so a `retained` node keeps one conversation across the activations of its run. Resume follows the Agent runtime's own semantics: a log whose tail never closed is closed by the loop, and the executor never repairs a session log itself.

**Completion.** The tool's parameter schema is `{ value: <node outputSchema> }`, validated with the shared JSON Schema validator. An invalid submission raises `ToolArgsError`, which the tool pipeline reports as an error result so the model can correct it inside the same turn. A valid submission is staged by execution identity and committed only after its own `tools/result` succeeds, keyed so a later pipeline failure discards it; a monotonic guard then refuses every later tool call in that turn, which is what makes a duplicate call unable to replace or extend a recorded result. `exec.concludeTurn()` ends the turn, and the scheduler commits the value as the attempt's result in its own transaction, so the completion and the attempt row land together or not at all.

**Lifetime.** One call is one turn. The executor sends the task message, waits for the agent to reach quiescence, reads the outcome, and disposes the Agent handle — the session, not the Agent, is what a retained node keeps. The scheduler's abort signal cancels the turn and is then rethrown, and the deadline cancels the turn before reporting `agent/timeout`.

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin, executor registration, composition, turn driving, outcome mapping |
| `src/completion.ts` | Completion tool, its prompt section, terminal guard, and two-phase capture |
| `src/node-sessions.ts` | `ctx.mwfNodeSessions`, the live session-to-attempt registry |
| `src/retained-sessions.ts` | The durable retained-session mapping in the project database |
| `src/types.ts` | Configuration, failure codes, and the session record |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam these services belong to.
- [Workflow scheduler](../scheduler/README.md) — who dispatches the activations this plugin runs.
- [Workflow project store](../project-store/README.md) — where definition revisions, runs, and the retained-session row live.
- [Workflow definition](../definition/README.md) — the agent node configuration this executor reads.
- [Generated configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-agent-executor) — every accepted field.

-----

<a id="model-experience"></a>
## Model Experience

### Node instruction section

#### What the model sees

The node's stored `config.instructions`, registered as the `workflow:node-instructions` section at the deployment persona-prefix order with interpolation disabled, so a definition's text reaches the model verbatim and no deployment prompt variable rewrites it. The text itself is project data, so only its placement and lifetime belong to this package.

#### Token effect

Retained: the section is re-rendered on every request of the node's conversation, so its cost is paid once per model call for as long as the conversation lasts.

#### KV Cache effect

Append-only. The section text is fixed for a given stored revision, so it extends an already-reusable prefix instead of replacing it; a new definition revision, a different node, or a `fresh` node's new session starts an independent request series.

### Completion tool

#### What the model sees

The `submit_node_result` tool declaration, whose single required `value` parameter is the node's stored `outputSchema`, plus one trailing instruction section that names the tool and forbids finishing with plain text.

##### Completion instruction

```markdown
When the node's work is complete, you MUST report its result by calling the `submit_node_result` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only that tool call counts as the node result.
```

#### Token effect

Conditional. The declaration is present on every request of the node's turn and its parameter schema grows with the node's output schema; the instruction section is a fixed sentence.

#### KV Cache effect

Append-only within one turn. The declaration and the instruction are stable for the whole conversation, so they keep the prefix reusable; a different node's output schema, or a definition revision that changes it, produces a different request series.

### Task message

#### What the model sees

One user-role message naming the node, its `iteration` and `attempt` numbers, and the activation's assembled input values as a JSON code block.

#### Token effect

Retained: the message is appended once per activation and stays in the conversation's history, so a `retained` node pays for it on every later request.

#### KV Cache effect

Append-only. Each activation appends a new message after the previous turn, so the earlier prefix stays reusable; the JSON payload differs per activation and therefore never matches an earlier request's tail.

## Known Limitations and Deferred Work

- **No coordinator session** — a child Agent records no `parentSession`, because the run has no coordinating conversation yet; the durable lineage a later stage needs arrives with that conversation.
- **Deployment-wide model** — a node cannot select its own provider, model, or reasoning effort; every child uses `ctx.agentDefaultModel` until the definition model grows a model field.
- **Completion tool inside this package** — the tool, its instruction, and its guard live here until the shared workflow tool package owns them.
- **No artifact publication** — a node reports a JSON value only, so files a child writes are not published as `NodeArtifact` records and an `artifact` input binding has nothing to read from this executor.
- **One turn per activation** — the executor sends one task message and never steers, so a child that asks a question or waits for input ends the turn as `agent/completion-missing` rather than suspending the activation.
- **Permission state is not captured** — the child inherits whatever the composition grants its scope; this stage captures no delegation policy onto the session log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Suites mount the real Agent loop, a JSONL session backend, the project store, the scheduler, and the executor over one temporary home, and drive model calls through a scripted adapter, so composition, memory, completion, and outcome mapping are asserted without a provider. The retained-memory cases use a loop edge, because a loop iteration is the only way one run activates the same node twice. Corrupted-media cases write through a second SQLite connection with foreign keys disabled, which is how a case reproduces a definition or mapping row that a live store would refuse to damage.

</details>

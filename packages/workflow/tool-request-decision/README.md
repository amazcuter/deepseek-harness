---
description: "Model-facing decision tool for workflow agent nodes: the request_decision definition, the one-pending-request rule, the turn it ends, and the card metadata a waiting request records."
kind: "package-library"
---

# @metaworkflow/tool-request-decision

English | [中文](README.zh.md)

## Summary

`@metaworkflow/tool-request-decision` owns the one tool a workflow agent node asks its project coordinator a question through. `createRequestDecisionTool({ onRequest })` returns the `request_decision` definition whose `question`, `options`, and `detail` parameters describe the decision the node needs; `attach(childCtx)` installs it in the node's scope. One call records one pending request, returns `{ status: 'pending', requestId }`, and ends the turn, which is what suspends the node and releases its scheduler execution slot. The coordinator's answer reaches the resumed attempt as an input, never as another tool result, and a second call in the same attempt is refused.

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

### When to use it

Use it when a workflow node cannot decide something from its own inputs and a human-facing coordinator must answer before the node continues. The current consumer is [`@metaworkflow/workflow-agent-executor`](../agent-executor/README.md), which creates one tool per activation and binds `onRequest` to the project's decision rows. Do not use it as a general user-question tool: the answer arrives as the resumed activation's input, and the turn ends on the request.

### Entry points

| Export | Behavior |
|---|---|
| `createRequestDecisionTool(options)` | Builds one attempt's tool definition and its scope wiring |
| `tool.attach(childCtx)` | Registers the definition in the child Agent's scope |
| `DECISION_TOOL_NAME` | The default model-facing name, `request_decision` |
| `DECISION_TOOL_DESCRIPTION` | The default model-facing description |
| `DECISION_CARD_TITLE` | The card header a pending request's presentation metadata carries |

`RequestDecisionToolOptions` carries the attempt's `onRequest` sink and optional `name` and `description` overrides. `DecisionRequest` is what the sink receives: the question, the candidate answers the node proposed, and its structured detail. `RequestDecisionTool` is the returned definition: every `ToolDefinition` member the model sees, plus `attach`. `RequestDecisionResultMeta` is the card metadata a pending request persists.

### Minimal composition

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createRequestDecisionTool } from '@metaworkflow/tool-request-decision'

/**
 * Give one child Agent scope the node's decision tool.
 * @param childCtx - the child Agent's scope context, during its creation window.
 * @param record - stores the request and returns its id.
 */
export function compose(childCtx: Context, record: (question: string) => Promise<string>): void {
  const tool = createRequestDecisionTool({
    onRequest: async request => await record(request.question),
  })
  tool.attach(childCtx)
}
```

Every registration belongs to the scope `attach` runs in, so disposing that scope removes the tool; two concurrent nodes never observe each other's decision tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

**Definition.** The tool is built with `defineTool`, so the parameter schema is a static DSL declaration and the registry backfills invalid arguments as an ordinary `ToolArgsError` result the model corrects inside the same turn: `question` (required string), `options` (optional string array), and `detail` (optional arbitrary JSON). Its canonical output is `{ status: 'pending', requestId }`.

**One pending request.** The factory keeps the request it already recorded. A second call throws before reaching `onRequest`, and the error result tells the model to wait for the answer instead of asking again; the tool instance belongs to one attempt, so a resumed attempt asks afresh. A rejected `onRequest` records nothing, so the node is never left waiting on a request the coordinator never received.

**Turn end.** `exec.concludeTurn()` marks the successful result as terminal for the turn. The executor reads the recorded request from its own sink and reports the activation `waiting` to the scheduler; a model that ends the turn with plain text suspends nothing.

**Card metadata.** `output.presentationMeta` projects `{ title: 'Waiting for a coordinator decision', summary }` from the asked question, with the summary bounded to 200 characters. The projection runs on replayed logged arguments too, so a call without a question yields a stable placeholder rather than an error.

| File | Responsibility |
|---|---|
| `src/index.ts` | The tool definition, the one-request rule, the turn end, and the card projection |
| `src/types.ts` | Options, the received request, the returned tool type, and the persisted card metadata |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow agent executor](../agent-executor/README.md) — the current consumer, which binds `onRequest` to one attempt's decision rows.
- [Workflow coordinator](../coordinator/README.md) — the Session whose tools answer the request.
- [Workflow scheduler](../scheduler/README.md) — the `waiting` activation this tool suspends and `resumeActivation` wakes.
- [Tool authoring reference](../../../docs/cookbook/adding-a-tool.md) — the contracts a model-facing tool satisfies.
- [Generated tool catalog](../../../docs/tool-catalog.md#metaworkflowtool-request-decision) — the schema the model receives.

-----

<a id="model-experience"></a>
## Model Experience

### Decision tool schema

#### What the model sees

The generated [`request_decision` schema](../../../docs/tool-catalog.md#metaworkflowtool-request-decision): one required question, optional candidate answers, and optional structured detail. `name` and `description` can replace the model-facing identity.

#### Token effect

Conditional. The declaration is present on every request of the node's turn, and its result text names the request id the coordinator will answer.

#### KV Cache effect

Append-only within one node conversation. The declaration is stable, so it keeps the request prefix reusable.

### Resume input

#### What the model sees

Nothing on the asking turn beyond the tool result. The resumed attempt's task message carries the coordinator's answer as one more input value under `decision`, so the model continues a turn that knows what was decided.

#### Token effect

Fixed per resume: one JSON value in the input block of the resumed turn.

#### KV Cache effect

Append-only. The resumed turn appends a user message to the same conversation under `retained` memory, or starts a fresh one under `fresh` memory.

## Known Limitations and Deferred Work

- **One request per attempt** — the tool refuses a second call in the same attempt, so a node that needs two decisions asks once, resumes, and asks again.
- **No presenter** — the tool persists card metadata only, so a UI without a tool-specific presenter shows its generic card; the M4d workbench card consumes the metadata.
- **The answer is not redacted** — whatever the coordinator answers is copied into the resumed node's input verbatim, so a coordinator must not put credentials in an answer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Suites mount a real tool runtime and prompt registry, then drive the tool through `ctx.tools.execute`, so argument validation, the one-request rule, the turn end, and the persisted metadata are asserted without an Agent loop. The rejected-sink case fails the first call and then asks again, which is how the "records nothing" guarantee is pinned.

</details>

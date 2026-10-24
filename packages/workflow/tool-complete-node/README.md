---
description: "Model-facing completion tool for workflow agent nodes: the submit_node_result definition, its two-phase commit, its monotonic duplicate guard, and the card metadata an accepted node result records."
kind: "package-library"
---

# @metaworkflow/tool-complete-node

English | [中文](README.zh.md)

## Summary

`@metaworkflow/tool-complete-node` owns the one tool a workflow agent node reports its result through. `createCompleteNodeTool({ outputSchema, onAccept })` returns the `submit_node_result` definition whose single required `value` parameter is that node's stored output schema, and `attach(childCtx)` installs the definition, its instruction section, a monotonic guard, and the commit that calls `onAccept` only after the submission's own `tools/result` succeeded. A plain assistant message is never a completion, an invalid value is an ordinary `ToolArgsError` the model corrects in the same turn, and a node that recorded a result cannot submit a second one.

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

Use it when a workflow node must report a structured result that a scheduler commits, and when an ordinary assistant answer must not count as that result. The current consumer is [`@metaworkflow/workflow-agent-executor`](../agent-executor/README.md), which creates one tool per activation and binds `onAccept` to that attempt's completion slot. Do not use it as a general structured-output tool: the guard makes a scope single-use, so a second activation needs a second tool.

### Entry points

| Export | Behavior |
|---|---|
| `createCompleteNodeTool(options)` | Builds one attempt's tool definition and the wiring that commits what it accepts |
| `tool.attach(childCtx)` | Registers the definition, its instruction section, its duplicate guard, and the two-phase commit in the child Agent's scope |
| `completionInstruction(toolName)` | The trailing instruction naming a completion tool, for a deployment that renames it |
| `COMPLETION_TOOL_NAME` | The default model-facing name, `submit_node_result` |
| `COMPLETION_TOOL_DESCRIPTION` | The default model-facing description |
| `COMPLETION_INSTRUCTION` | The instruction text for the default name |

`CompleteNodeToolOptions` carries the node's `outputSchema`, the attempt's `onAccept` sink, and optional `name` and `description` overrides. `CompleteNodeTool` is the returned definition: every `ToolDefinition` member the model sees, plus `attach`. `CompleteNodeResultMeta` is the card metadata an accepted submission persists.

### Minimal composition

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createCompleteNodeTool } from '@metaworkflow/tool-complete-node'
import type { JsonValue } from '@metaworkflow/util-values'

/**
 * Give one child Agent scope the node's completion tool.
 * @param childCtx - the child Agent's scope context, during its creation window.
 * @param accept - the attempt's sink for the accepted value.
 */
export function compose(childCtx: Context, accept: (value: JsonValue) => void): void {
  const tool = createCompleteNodeTool({
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    onAccept: accept,
  })
  tool.attach(childCtx)
}
```

Every registration belongs to the scope `attach` runs in, so disposing that scope removes the tool, its section, its guard, and its listener; two concurrent nodes never observe each other's completion tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

**Definition.** The tool is registered as a raw `ToolDefinition` rather than through `defineTool`, because the parameter schema is the node's stored JSON Schema verbatim and the DSL cannot carry an arbitrary stored schema. Its parameters are `{ value: <outputSchema> }` with `value` required and no other property accepted, and its canonical output is `{ recorded: true }` rendered as `Node result recorded.`.

**Validation.** `execute` validates the arguments against that same parameter schema and throws `ToolArgsError` with the path-qualified violations, which the tool pipeline reports as an error result so the model corrects the value inside the same turn. A valid value is staged under the execution identity and `exec.concludeTurn()` ends the turn.

**Two-phase commit.** The staged value is not the result. A `tools/result` listener commits it only when the submission's own result succeeded, so a later policy that turns that result into a failure leaves nothing behind. A nested dispatch — a completion call carrying an enclosing transport token — commits with the enclosing call's outcome instead, so a failed transport discards it. The first commit wins: a monotonic guard rejects every later call in the scope, which is what makes a duplicate call unable to replace or extend a recorded result.

**Card metadata.** `output.presentationMeta` projects `{ title, summary }` from the submitted value, with the summary bounded to 200 characters of one-line JSON. The projection runs on replay of logged arguments too, so a call without a submitted value yields a stable placeholder rather than an error, and a UI with no presenter still falls back to its generic card.

| File | Responsibility |
|---|---|
| `src/index.ts` | The tool definition, its instruction, its guard, the two-phase commit, and the card projection |
| `src/types.ts` | Options, the returned tool type, and the persisted card metadata |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow agent executor](../agent-executor/README.md) — the current consumer, which binds `onAccept` to one attempt.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam these services belong to.
- [Tool authoring reference](../../../docs/cookbook/adding-a-tool.md) — the contracts a model-facing tool satisfies.
- [Generated tool catalog](../../../docs/tool-catalog.md#metaworkflowtool-complete-node) — the schema the model receives.

-----

<a id="model-experience"></a>
## Model Experience

### Completion tool schema

#### What the model sees

The generated [`submit_node_result` schema](../../../docs/tool-catalog.md#metaworkflowtool-complete-node), whose single required `value` parameter is the executing node's stored `outputSchema`. `name` and `description` can replace the model-facing identity; the parameter schema always follows the stored output schema.

#### Token effect

Conditional. The declaration is present on every request of the node's turn, and its parameter schema grows with the node's output schema.

#### KV Cache effect

Append-only within one node conversation. The declaration is stable for a given stored revision, so it keeps the request prefix reusable; a different node, a changed output schema, or a renamed tool produces a different request series.

### Completion instruction section

#### What the model sees

One trailing section at the structured-output order, naming the tool this scope registered and forbidding a plain text finish.

##### Completion instruction

```markdown
When the node's work is complete, you MUST report its result by calling the `submit_node_result` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only that tool call counts as the node result.
```

#### Token effect

Fixed. The section is one sentence re-rendered on every request of the node's conversation.

#### KV Cache effect

Append-only. The text is fixed for a given tool name, so it extends an already-reusable prefix instead of replacing it.

## Known Limitations and Deferred Work

- **One accepted result per tool instance** — the guard makes a scope single-use, so a consumer that runs several attempts must create one tool per attempt; reuse would refuse the second attempt's submission.
- **No `presentCall` or `presentResult`** — the tool persists card metadata only, so a UI without a tool-specific presenter shows its generic card; no first-party card consumes the metadata yet.
- **Summary is bounded text** — the metadata keeps 200 characters of one-line JSON, not a retrievable copy of the value, so a large node result is summarized rather than reproduced.
- **No schema evolution** — the parameter schema is the stored output schema verbatim; this package validates it but does not translate or migrate an older node's schema.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Suites mount a real tool runtime and prompt registry, then drive the tool through `ctx.tools.execute`, so argument validation, the guard, the two-phase commit, and the persisted metadata are asserted without an Agent loop. The nested-dispatch cases register a small transport tool that dispatches the completion tool with its own token, which is how a PTC transport reaches a native call.

</details>

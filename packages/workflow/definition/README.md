---
description: "Pure workflow graph model for a project's definition document: the JSON record, the validator that decides whether a graph is executable, and the routing and join arithmetic a scheduler needs."
kind: "package-library"
---

# @metaworkflow/workflow-definition

English | [中文](README.zh.md)

## Summary

Use `@metaworkflow/workflow-definition` to store, check, and route one workflow graph. `parseDefinitionDocument` accepts JSON text, validates every rule, and returns a typed definition; `route` turns one node result into the targets its outgoing edges activate; `computeJoin` reports when a node's incoming edges are satisfied. The package is pure: it schedules nothing, executes no node, registers no service, and never evaluates an expression — conditions compare JSON fields only. Definitions travel as JSON, so no YAML dependency is required.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

A caller that stores a workflow document, or one that decides what runs next, imports this package instead of re-deriving graph rules. The workflow scheduler stage (M4) is the intended consumer: it reads a revision document from `ctx.mwfProjectStore`, parses it here, and asks `route` and `computeJoin` what to activate. Editors and importers use `validateDefinition` to explain a document that cannot run.

### Entry point

```ts
import type { JsonValue } from '@metaworkflow/util-values'
import { parseDefinitionDocument, route } from '@metaworkflow/workflow-definition'

declare const documentText: string
declare const nodeResult: JsonValue

const parsed = parseDefinitionDocument(documentText)
if (!parsed.ok) {
  for (const violation of parsed.violations) console.error(`${violation.code} at ${violation.path}: ${violation.message}`)
} else {
  const [entry] = parsed.definition.nodes
  if (entry !== undefined) {
    const decision = route(nodeResult, entry, parsed.definition.edges)
    if (decision.failure !== null) console.error(decision.failure.code, decision.failure.candidates)
  }
}
```

`parseDefinitionDocument` returns `{ ok: true, definition }` or `{ ok: false, violations }`; it never throws and never repairs a document. `serializeDefinition` writes the canonical text (object keys sorted, node and edge order preserved), so equal definitions produce identical stored revisions.

### The document

| Value | Fields |
|---|---|
| `WorkflowDefinition` | `version: 1`, `nodes`, `edges` |
| `WorkflowNode` | `id`, `kind` (`python` \| `agent`), `title`, `config`, `inputs`, `join` (`all` \| `first-success`) |
| python `config` | `source` — Python text containing `def nodemain_<nodeId>(` |
| agent `config` | `outputSchema`, `instructions`, `tools`, `memory` (`retained` \| `fresh`) |
| `InputBinding` | `name`, `source` = `{ kind: 'node', nodeId, field }` \| `{ kind: 'run', key }` \| `{ kind: 'artifact', name }` |
| `WorkflowEdge` | `id`, `from`, `to`, `condition`, `mode` (`exclusive` \| `multiple`), optional `fallback`, optional `loop: { maxIterations }` |
| `Predicate` | `{ op, field, value? }` for `eq ne gt gte lt lte in not-in exists truthy`, `{ op: 'and' \| 'or', args }`, `{ op: 'not', arg }` |

Field paths are dot-separated (`review.passed`, `items.0.name`) and read JSON object properties and array indices only. Paths are data: nothing is evaluated as code.

Schema subset checking delegates to `assertSupportedJsonSchema` in `@metaworkflow/tools`, so an agent node accepts exactly the schemas a subagent structured output accepts. `definition/schema-unsupported` carries the shared validator's own path-qualified reasons.

The `outputSchema` uses the enforced JSON Schema subset that `@metaworkflow/tools` shares with subagent structured output: one scalar `type`, object `properties`/`required`/boolean `additionalProperties`, array `items`, scalar `enum`/`const`, exactly-one `oneOf`, and the `description`, `title`, `default`, and `examples` annotations. The root must be `type: "object"`. Every other keyword is a violation, so a document can never carry a rule the runner would not enforce.

### Validation

`validateDefinition(value)` accepts a value of unknown origin and reports every rule it breaks, each with a stable code and a document path such as `edges[2].condition.field`.

| Code | Rule |
|---|---|
| `definition/document-invalid` | the document must be a JSON object |
| `definition/version-unsupported` | `version` must be `1` |
| `definition/nodes-invalid`, `definition/edges-invalid` | both must be arrays |
| `definition/node-invalid`, `definition/edge-invalid` | list members must be objects |
| `definition/node-id-invalid`, `definition/edge-id-invalid` | ids must match `^[a-z][a-z0-9_-]*$` |
| `definition/duplicate-node`, `definition/duplicate-edge` | ids are unique |
| `definition/node-kind-invalid`, `definition/node-config-kind-mismatch` | `kind` is `python` or `agent`, and equals `config.kind` |
| `definition/node-title-empty` | titles are non-empty |
| `definition/node-join-invalid` | `join` is `all` or `first-success` |
| `definition/node-config-invalid` | `config` is an object |
| `definition/python-source-empty`, `definition/python-entry-missing` | Python source is non-empty and defines `def nodemain_<nodeId>(` |
| `definition/agent-instructions-empty`, `definition/agent-memory-invalid`, `definition/agent-tools-invalid` | agent instructions are non-empty, memory is `retained` or `fresh`, tools are unique non-empty names |
| `definition/schema-invalid`, `definition/schema-root-not-object`, `definition/schema-unsupported` | the output schema is a supported subset schema with an object root |
| `definition/node-inputs-invalid`, `definition/input-name-invalid`, `definition/duplicate-input` | inputs are an array of uniquely named bindings |
| `definition/input-source-invalid`, `definition/run-key-empty`, `definition/artifact-name-empty` | each source names a node, a non-empty run key, or a non-empty artifact |
| `definition/input-field-invalid` | a node input field is a dot-separated path |
| `definition/input-node-not-ancestor` | a node input reads an ancestor's result |
| `definition/condition-invalid`, `definition/condition-field-invalid`, `definition/condition-value-invalid`, `definition/condition-args-invalid`, `definition/condition-too-deep` | conditions use known ops, path fields, type-matching values, non-empty `args`, and bounded nesting |
| `definition/edge-endpoint-missing` | both endpoints name declared nodes |
| `definition/edge-mode-invalid`, `definition/mixed-edge-modes` | modes are known, and one node uses one mode |
| `definition/self-loop` | an edge does not target its own source unless it is a loop edge |
| `definition/fallback-invalid`, `definition/fallback-condition`, `definition/fallback-mode`, `definition/multiple-fallback-edges` | at most one fallback per node, exclusive only, and never conditioned |
| `definition/loop-invalid`, `definition/loop-max-iterations-invalid`, `definition/loop-edge-mode`, `definition/loop-target-not-ancestor`, `definition/multiple-loop-edges` | a loop declares only `maxIterations` (an integer of at least 1), uses `multiple` mode, re-enters an ancestor, and is unique per node |
| `definition/no-entry-node`, `definition/multiple-entry-nodes` | exactly one node has no incoming edge |
| `definition/unreachable-node` | every node is reachable from the entry node |
| `definition/graph-cycle` | edges other than loop edges form no cycle |
| `definition/join-first-success-degree` | `first-success` is used only on a node with at least two incoming edges |

Four rules settle cases the document format leaves open. A `loop` edge must use `mode: "multiple"`: an exclusive group selects one edge per activation, so a re-entry edge inside it would make the forward choice and the iteration count ambiguous. Every outgoing edge of one node shares one mode, because routing then resolves one selection policy per node. A fallback edge is exclusive and carries no condition, because it is selected without evaluation. A node id, once declared, is the identity edges and inputs refer to; a duplicated id is a violation rather than a shadowing rule.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | The document types, violation and routing codes, and join values |
| [`src/document.ts`](src/document.ts) | `WORKFLOW_DEFINITION_VERSION`, canonical serialization, and the JSON-only parse step |
| [`src/validate.ts`](src/validate.ts) | Every rule above, in document order per pass |
| [`src/predicate.ts`](src/predicate.ts) | Condition evaluation over one node result |
| [`src/route.ts`](src/route.ts) | Exclusive and multiple edge selection, fallback, and loop counting |
| [`src/join.ts`](src/join.ts) | `computeJoin` and the fired state transition |
| [`src/path.ts`](src/path.ts) | Dot-separated path parsing and JSON reads |
| [`src/json.ts`](src/json.ts) | JSON narrowing and canonical key ordering |

### Routing

`route(result, node, edges)` considers only the edges that leave `node`, so the whole edge list may be passed.

- An **exclusive** group evaluates its conditional edges in document order. Exactly one match selects that edge; no match selects the fallback when one exists, otherwise routing fails with `routing/no-match`; two or more matches fail with `routing/ambiguous`, and `failure.candidates` lists every matching edge id. A fallback edge is never evaluated.
- **Multiple** edges activate independently; targets keep document order and are deduplicated, while `edgeIds` keeps one entry per activated edge.
- A failed exclusive group fails the whole decision: `targets` is empty even when a multiple edge matched.
- `iterationDelta` counts the activated loop edges. The scheduler owns the iteration counter and advances it by that count.
- Every incomparable condition reports a diagnostic with the edge id. An unconditional edge (`condition: null`) matches without evaluation.

### Conditions

Evaluation reads only business fields of the result; a name such as `next` is an ordinary field, so a result cannot steer control flow.

- A missing field makes `exists` and `truthy` false, and every value comparison reports `predicate/field-missing` and matches nothing.
- Types are strict: a comparison whose operands fall in different JSON categories (`null`, `boolean`, `number`, `string`, `array`, `object`) reports `predicate/type-mismatch` and matches nothing. No coercion happens.
- `gt`, `gte`, `lt`, `lte` require two numbers, so `NaN` satisfies none of them; `in` and `not-in` compare array elements strictly and report a type mismatch when no element shares the field's category.
- `and` and `or` evaluate every argument before combining, so diagnostics describe the whole condition, not just the deciding branch.

### Joining

`computeJoin(joinPolicy, activatedIncoming, completed, state?)` is a pure set operation plus a state transition; the scheduler passes the returned `state` back on the next step.

- `all` fires once every activated incoming edge has completed. An edge that was never activated is not expected, and an empty activated set never fires.
- `first-success` fires on the first completed activated edge, then reports later completions in `consumed` while `fire` stays false.
- Failure handling is not here: `completed` holds successful completions only, and the scheduler decides what a failed branch means.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow project store](../project-store/README.md) — stores definition revisions as document text.
- [Workflow Python runner](../python-runner/README.md) — runs the `nodemain_<nodeId>` function a python node declares.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the run and event vocabulary a scheduler composes around this model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No scheduler, execution, or persistence** — this package decides what a graph means; activation, iteration counters, retries, and failure containment belong to the workflow scheduler stage.
- **Schemas are a subset** — `$ref`, `anyOf`, `allOf`, `pattern`, numeric and string bounds, and schema-valued `additionalProperties` are rejected with `definition/schema-unsupported`; an agent node cannot express them yet. The subset belongs to `@metaworkflow/tools`, so widening it is that package's change.
- **Conditions compare fields only** — no arithmetic, no expression evaluation, and no function calls; `eq` and `in` compare JSON scalars, so two structurally equal objects never match.
- **Nesting is capped** — predicates are accepted to depth 32 and schemas to depth 16, and deeper documents are rejected rather than truncated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

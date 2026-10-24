---
description: "Pure Mermaid flowchart import for workflow projects: a parser for the step-and-arrow subset, and the translation of its graph into a definition the workflow validator accepts."
kind: "package-library"
---

# @metaworkflow/workflow-mermaid-import

English | [中文](README.zh.md)

## Summary

Use `@metaworkflow/workflow-mermaid-import` to turn a flowchart someone already drew into a runnable workflow graph. `parseMermaidFlowchart` reads a `flowchart` header, node statements, and arrows into nodes and edges; `toDefinition` renames the nodes to stable ids, routes every link as an exclusive `route` comparison, and validates the result with `@metaworkflow/workflow-definition`. The package is pure: it parses Mermaid itself instead of depending on it, mounts no service, and never throws.

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

The `projects.importMermaid` Remote verb uses this package: an author pastes a flowchart, the Host parses and translates it, and the accepted graph is stored as the project's newest definition revision. A tool or an editor that previews an import calls the same two functions. Anything that needs to explain a refused flowchart reads the diagnostic rather than guessing: every refusal carries a stable code, and a source line when the text has one.

### Entry point

```ts
import { parseMermaidFlowchart, toDefinition } from '@metaworkflow/workflow-mermaid-import'

const parsed = parseMermaidFlowchart(`flowchart TD
  Start[Fetch the invoice] --> Review{Review}
  Review -->|approved| Done[File it]
  Review -->|rejected| Rework[Send it back]`)
if (!parsed.ok) {
  console.error(parsed.error.code, parsed.error.line, parsed.error.message)
} else {
  const translated = toDefinition(parsed.graph)
  if (!translated.ok) console.error(translated.error ?? translated.violations)
  else console.log(translated.mapping, translated.definition)
}
```

### The accepted subset

| Source | Read as |
|---|---|
| `flowchart TD`, `flowchart LR`, `flowchart BT`, `flowchart RL` | the header and its layout direction; `graph` is accepted in place of `flowchart` |
| `A`, `A[Label]`, `A(Label)`, `A{Label}` | one node; the label may be wrapped in double quotes, and may follow a space |
| `A --> B` | one edge |
| `A -->\|Label\| B` | one edge whose label becomes its condition value |
| `A --- B`, `A ---\|Label\| B` | one edge, identical to the arrows above |
| `A --> B --> C` | two edges, `A` to `B` and `B` to `C`; a pipe label binds to the link that carries it |
| `%% ...`, blank lines | ignored |
| a trailing `;` | tolerated |

Every other statement is refused instead of ignored, because dropping a line would silently change the graph. Refusals are `mermaid/missing-header` (the first statement is not a header, or the text has none), `mermaid/invalid-direction` (the header names no direction or an unsupported one), `mermaid/unsupported-syntax` (`subgraph`, `classDef`, `class`, `click`, `style`, `linkStyle`, `accTitle`, `accDescr`, `direction`, and the link forms `-.->`, `==>`, `~~~`, `--o`, `--x`, `-- text -->`), `mermaid/syntax-error` (unreadable node, unbalanced bracket or pipe, empty label, stray text), and `mermaid/duplicate-node` (one id declared with two different labels). Each refusal carries the 1-based line when the offending text has one.

Repeating a node id merges its mentions: a bare mention followed by a labelled one keeps the label, and the same label twice is a merge. A node named only by links is created with its id as the title and reported as the warning `mermaid/implicit-node`.

### The translation

| Rule | Result |
|---|---|
| node id | a slug of the label: lowercased, every character outside `[a-z0-9_-]` replaced by `-`, repeats collapsed, and leading or trailing `-`/`_` trimmed; a slug that does not start with a letter is prefixed `node-`, and an empty one becomes `node` |
| collisions | the first node keeps the slug and later ones take `-2`, `-3`, in node order, with the warning `mermaid/label-collision` |
| node kind | every node is an `agent` node: `title` is the label, `outputSchema` is `{ "type": "object" }`, `instructions` is `Complete the "<label>" step.` (override with `options.instructions`), `tools` is empty, `memory` is `fresh`, `inputs` is empty, and `join` is `all` |
| edge | `mode` is `exclusive`; a labelled link's condition is `{ op: 'eq', field: 'route', value: <label> }`, and an unlabelled link's condition is `null` |
| fallback | an unlabelled link whose source also has labelled links becomes the exclusive fallback, so the labelled alternatives are tried first |
| edge id | `<from>-<to>`, with `-2`, `-3` when two links join the same pair |
| repeated link | the second copy is dropped with the warning `mermaid/duplicate-edge` |
| entry node | every node without an incoming edge is an entry; the validator requires exactly one, so a flowchart with two disconnected starts comes back as violations |

`toDefinition` returns `{ ok: true, definition, mapping, warnings }` only when `validateDefinition` accepts the definition, where `mapping` is the mermaid id to generated id record. A cyclic flowchart is refused with `mermaid/cycle-unsupported`, naming the nodes that close the cycle, because this release imports forward edges only and a loop edge is configured on the canvas afterwards. A graph that translates but breaks a definition rule returns `{ ok: false, error: null, violations }` with every validator violation; neither case throws.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | The graph, diagnostic, option, and result types |
| [`src/parse.ts`](src/parse.ts) | The line pass, the statement scanner, node declaration, and warnings |
| [`src/definition.ts`](src/definition.ts) | Slug generation, edge building, cycle detection, and the validation call |
| [`src/index.ts`](src/index.ts) | The package entry point |

### Parsing

The parser reads the source one line at a time. The first non-comment, non-blank line must be the header; every later line is one statement. A statement is scanned left to right with a cursor: a node id, an optional shaped label, then zero or more `link node` pairs. Only after a whole statement scans cleanly are its nodes declared and its edges appended, so a refused statement never leaves half a graph behind.

Labels are recorded per node id, not per mention: the first explicit label wins, a conflicting one is refused, and a node mentioned bare first keeps its bare state until a label arrives. The parser reports the nodes whose only mentions were bare link endpoints, which is the one case where the import invents a title.

### Translation

`toDefinition` walks the nodes in first-mention order and reserves each slug before building the node, which is what makes repeated labels deterministic. It then walks the links in source order, drops a repeated `(from, to, label)` triple, and reserves each edge id. Cycle detection runs before any node is built: a depth-first walk over the links reports the first path that closes on itself, and the refusal names that path. The generated definition is the value `validateDefinition` checked, so a caller can store `serializeDefinition(result.definition)` without validating again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow definition](../definition/README.md) — the document, its validator, and the routing the generated conditions feed.
- [Workspace controller](../../api/workspace-controller/README.md) — the `projects.importMermaid` verb that stores an imported flowchart.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — how definitions, runs, and executors fit together.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Forward edges only** — a cyclic flowchart is refused with `mermaid/cycle-unsupported`; re-entry and `maxIterations` are configured on the canvas, so the import cannot express them yet.
- **One entry node** — the validator requires exactly one node without an incoming edge, so two disconnected starts come back as `definition/multiple-entry-nodes` instead of a synthesized start node.
- **Agent nodes only** — every node is an `agent` node with a placeholder instruction, an empty object schema, and no inputs or tools; a python node, a real output schema, and input bindings are authored after the import.
- **No statement ordering or chaining forms** — one statement per physical line, at most one trailing `;`, and the `A -- text --> B` inline-label form are outside the subset; a document using them is refused rather than partly read.
- **No layout or styling** — the header direction is recorded in the parsed graph and is not carried into the definition, because the definition format has no layout field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

---
description: "The workflow group map: model-authored orchestration scripts that fan out subagents, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/workflow

English | [中文](README.zh.md)

## Summary

The workflow group lets an agent run orchestration scripts that delegate work to subagents and return a final value. The `workflow` tool supports scripted fan-out. Scripts use the shared PTC Node process runtime under the calling Session's file policy. Workflow hooks and child lifecycle remain owned by the workflow engine.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workflow`](workflow/README.md) | Runs a model-written orchestration script that fans out subagents | `ctx.workflowEngine` |
| [`workflow-ptc`](workflow-ptc/README.md) | Runs workflow scripts through the shared sandboxed PTC Node process runtime | registers on `ctx.workflowEngine` |
| [`tool-workflow`](tool-workflow/README.md) | Gives the model the `workflow` tool for scripted multi-agent orchestration | registers on `ctx.tools` |
| [`project-store`](project-store/README.md) | Persists workflow projects: a global registry plus one database per project | `ctx.mwfProjectStore` |
| [`python-runner`](python-runner/README.md) | Runs one AI-written Python node function on the host and returns its JSON value | `ctx.mwfPythonRunner` |
| [`definition`](definition/README.md) | Defines, validates, and routes the workflow graph document | pure library (no `ctx` key) |
| [`scheduler`](scheduler/README.md) | Turns a stored definition into a durable, resumable run and drives node executors | `ctx.mwfScheduler` |
| [`python-executor`](python-executor/README.md) | Runs the scheduler's `python` activations on the real interpreter in the project working directory | `ctx.mwfPythonExecutor` |
| [`tool-complete-node`](tool-complete-node/README.md) | Gives a workflow agent node the `submit_node_result` tool that reports its structured result | pure library (no `ctx` key) |
| [`agent-executor`](agent-executor/README.md) | Runs the scheduler's `agent` activations as constrained DSH child Agents that report a structured result | `ctx.mwfAgentExecutor` |
| [`tool-request-decision`](tool-request-decision/README.md) | Gives a workflow agent node the `request_decision` tool that asks the project coordinator a question | pure library (no `ctx` key) |
| [`coordinator`](coordinator/README.md) | Gives each project one persistent coordinator Session that answers node decisions and reports project state | `ctx.mwfCoordinator` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Workflow subsystem](../../docs/subsystems/workflow.md) — the seam's types, start request, and `workflow/*` events.
- [Generated tool catalog](../../docs/tool-catalog.md#metaworkflowtool-workflow) — the `workflow` tool schema the model receives.
- [Generated tool catalog](../../docs/tool-catalog.md#metaworkflowtool-ralph) — the `ralph` tool schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#metaworkflowworkflow-ptc) — every accepted engine config field.
- [historical Dynamic workflows Agent Note](../../.agents/notes/archived/feature/2026-07-05-dynamic-workflows.md) — the seam design and its decisions.
- [Harness-level goal-based execution reference](../experimental/tool-ralph/README.md) — the fixed fresh-agent loop design and deferred work.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

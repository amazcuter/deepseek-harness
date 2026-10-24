# Agent Note: MetaWorkFlow project workflows

Status: implemented

English | [中文](2026-10-23-metaworkflow-project-workflows.zh.md)

## Problem

The MWF Web application is organized around conversations: the user picks a Session and works inside it. The MetaWorkFlow fork reorganizes that surface around workflow projects. The home page lists projects; a project holds its workflow canvas, coordinator conversation, node capabilities, and execution results. A user imports a Mermaid flowchart, develops the executable workflow through conversation, and runs independent MWF Agents and Python functions whose progress survives a restart.

This note records the decisions behind that product: which application and Harness home it runs in, where project state lives, how a stored graph becomes durable execution, what a node may do, and what the product deliberately leaves out.

## Decision

### One browser product with its own home

`mwf metaworkflow` opens the application through the `metaworkflow` entry in `PROFILE_TEMPLATES` ([profile.ts](../../../../packages/boot/app-boot/src/profile.ts), documented in [CLI help](../../../../docs/cli-help.md#mwf-metaworkflow)), which stacks `@metaworkflow/base` with `@metaworkflow/app` ([metaworkflow-app](../../../../packages/bundle/metaworkflow-app/README.md)). That bundle restates the Web surface's rows under MetaWorkFlow's own package, so the two products can change separately. The Desktop product, its data, and the `web` profile are unchanged.

`MWF_HOME` names the application's Harness home; the first launch initializes `$MWF_HOME/profiles/metaworkflow` from the shipped template, so the profile shares no sessions, settings, credentials, or patch files with another installation. The startup guard ([home-guard.ts](../../../../packages/bundle/metaworkflow-app/src/home-guard.ts)) refuses an unset or blank `MWF_HOME` and the shared `~/.mwf` and `~/.dsh` homes, and prints the command that fixes it; any other explicit path is accepted. The variable stays per terminal, because a permanent export would also move the Desktop product's home.

### Project storage and the registry

[workflow-project-store](../../../../packages/workflow/project-store/README.md) owns durability. A registry at `<home>/mwf/projects.db` lists every project, and each project owns one SQLite database at `<home>/mwf/projects/<projectId>/project.db`, never inside the project's working directory, so moving or deleting that directory leaves the records intact. The project database declares nodes, edges, activations, attempts, artifacts, and decisions; one connection per database per process serializes writes through `BEGIN IMMEDIATE`. An attempt's outcome, its state transitions, the activations it routes to, and its staged Session events commit in one transaction; `(attempt_id, event_seq)` is the outbox idempotency key, and a Session event is never written before the state row that produced it.

[workspace](../../../../packages/workspace/workspace/README.md) adds the product-facing registry over that identity: ordered projects, the Sessions that ran in each, pin and archive sets, and removal that keeps folders, files, and Sessions. A project therefore has one id across storage, the sidebar, and Sessions instead of two competing project concepts.

### Definition and routing

[workflow-definition](../../../../packages/workflow/definition/README.md) is the pure graph model stored as a revision. A document is JSON (`version: 1`) with nodes and edges. A node is `python` (source defining `def nodemain_<nodeId>(`) or `agent` (instructions, output schema, tool names, `retained` or `fresh` memory); every node declares `join: all | first-success` and its input bindings from a node field, a run parameter, or an artifact. Every edge carries a typed predicate, `exclusive` or `multiple` mode, an optional fallback, and an optional loop `maxIterations`. Conditions compare JSON fields through a fixed operator set; nothing is evaluated as code. `route` selects edges, reports `routing/no-match` or `routing/ambiguous`, and counts loop entries; `computeJoin` fires an `all` or `first-success` join. The validator reports one stable code per rule: one entry node, reachability, acyclic non-loop edges, ancestor-only inputs, loop edges targeting ancestors, and exclusive groups that mix modes.

### The scheduler

[workflow-scheduler](../../../../packages/workflow/scheduler/README.md) turns one stored revision into a durable run. `createRun` validates the revision and writes the run with its entry activation; `tick` starts ready activations up to `maxConcurrent` (4 by default) and re-evaluates as each settles; `maxAttempts` (2 by default) bounds retries. An activation is `(runId, nodeId, iteration)`, so a later loop round cannot satisfy an earlier join. Readiness, iteration, routing, and settlement commit with the attempt, so a crash leaves a run that `reconcile` can report: running attempts become `interrupted`, their activations return to `pending`, runs park, and waiting activations keep their state.

`pause` and `cancel` stop scheduling and abort in-flight attempts; `resume` reopens a paused run; `step` executes one named ready activation and parks the run; `retry` reopens a failed, canceled, or waiting activation as a new attempt; `resumeActivation` delivers a decision answer and advances the run. A waiting activation releases its execution slot and never satisfies a join. The scheduler ships no executor: a node kind is registered, and a ready activation whose kind has none fails the run with `scheduler/executor-missing`. A run reads one revision for its whole life, so a definition edited mid-run is refused as `scheduler/stale-result` rather than applied to the affected activations. Artifacts are recorded references by name, version, and relative path, not files the scheduler writes or verifies.

### Python nodes

[workflow-python-runner](../../../../packages/workflow/python-runner/README.md) runs one AI-written function as a real child process. It resolves the interpreter in order — an explicit path, the project `.venv`, the configured path, a platform probe — and every tier must report CPython 3.10–3.14 with the GIL; free-threaded builds are refused. Each project keeps one `.venv` at `<projectDir>/.venv`, installs with `pip install --only-binary=:all:` because the host has no MSVC toolchain, and calls for one project serialize.

The runner writes `<projectDir>/nodes/<nodeId>/node_main.py` beside its `node_runner.py` and calls `nodemain_<id>(inputs)`. Inputs travel as UTF-8 JSON on stdin rather than argv. The returned JSON string is re-emitted on one stdout sentinel line, `__MWF_RESULT__ <json>`, which log truncation cannot swallow; diagnostic stdout and stderr are capped separately and never treated as the result. The child environment sets `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, and `PYTHONUNBUFFERED=1`, because a GBK host locale otherwise mangles Chinese text and raises on emoji. A deadline terminates the whole process tree — `taskkill /PID <pid> /T /F` on Windows, a signal to the process group elsewhere, retried once — because `child.kill()` reaches only the process the runner started. A project directory over 200 characters is rejected with `project/path-too-long`, because a longer one makes `CreateProcess` fail with `WinError 267`.

[workflow-python-executor](../../../../packages/workflow/python-executor/README.md) supplies the `python` kind. It reads the activation's stored revision, opens the project, ensures the environment, runs the node, and reports `succeeded` with the JSON value or `failed` with the runner's code. Only `node/timeout` is retryable; environment problems and a node's own exception are not, so a broken node does not spend its attempt budget repeating the same fault.

### Agent nodes

[workflow-agent-executor](../../../../packages/workflow/agent-executor/README.md) supplies the `agent` kind. Each activation composes one child Agent from the stored node: the instructions become its persona, `ctx.tools.restrict({ allow })` filters its tools, the memory policy decides Session reuse, and it receives `submit_node_result`, whose `value` parameter is the node's output schema, together with `request_decision`. The child runs as a subagent Session with `parentSession` set and `origin: 'subagent'`, so cold recovery replays its descriptor the way a subagent run does.

`retained` memory reuses that Session across activations; `fresh` starts a new one each time. Retained is not a compaction setting: compaction is one service per composition, configured per provider and model, so it applies to a reused node Session like any other conversation and cannot be switched per node. Model choice is deployment-wide: every child uses the deployment default model, and the definition has no per-node model field. A node's result is only what the completion tool accepted; files the child writes are not published as artifacts, because no executor publishes them.

### Completion and decisions

[tool-complete-node](../../../../packages/workflow/tool-complete-node/README.md) owns `submit_node_result`. Its single `value` parameter is the node's stored output schema verbatim; an invalid value is an ordinary tool-argument error the model corrects in the same turn. A valid value stages under the attempt and commits only after the submission's own `tools/result` succeeded, and a monotonic guard refuses every later submission in the scope, so a duplicate call can neither replace nor extend a recorded result. Plain assistant prose never completes a node; an activation that ends a turn without a completion and without a decision request fails as `agent/completion-missing`.

[tool-request-decision](../../../../packages/workflow/tool-request-decision/README.md) owns `request_decision({ question, options, detail })`. One call records one pending request, returns `{ status: 'pending', requestId }`, and ends the turn, so the activation becomes `waiting` and releases its slot; a second request in the same attempt is refused. The coordinator's answer reaches the resumed attempt as an input named `decision`, never as another tool result, so a node treats it as data rather than a tool reply.

### Coordinator

[workflow-coordinator](../../../../packages/workflow/coordinator/README.md) gives each project one persistent coordinator Session. `ensureSession(projectId)` creates and records it on first use and resumes the recorded one afterwards, so the conversation outlives the process. Its tools are `answer_decision({ requestId, answer })`, which records the answer and resumes the waiting activation through `ctx.mwfScheduler.resumeActivation`; `list_pending_decisions()`, which lists unanswered requests oldest first with the options the node proposed; and `get_project_state()`, which reports the project, its runs with status and reason, and the newest run's activations with attempt counts. An answer to an activation that stopped waiting is recorded and the refused resume is reported rather than repaired; `retry` remains the path that delivers no answer. Decision events stay out of the Session log, so a UI subscribes instead of deriving them from conversation history.

### Mermaid import and the canvas

[workflow-mermaid-import](../../../../packages/workflow/mermaid-import/README.md) is a pure library. `parseMermaidFlowchart` reads a `flowchart` or `graph` header with `TD`, `LR`, `BT`, or `RL`, node statements, and arrows; `toDefinition` renames nodes to stable ids, translates every link into an exclusive `route` comparison, and validates the result with the definition validator. The accepted subset is deliberately small: forward edges only (a cyclic flowchart is refused with `mermaid/cycle-unsupported`), exactly one entry node, one statement per line, no `A -- text --> B` form, and no layout or styling. Every imported node is an `agent` node with a placeholder instruction, an empty object schema, and no inputs or tools; Python nodes, real schemas, and bindings are authored afterwards. The `projects.importMermaid` Remote verb registers the project, parses, translates, and stores the definition as the project's first revision; a refused flowchart registers nothing.

The canvas in [client-ui-mw-projects](../../../../packages/client/ui-mw-projects/README.md) redraws the stored definition as a Mermaid flowchart: one node per definition node, one arrow per edge, condition text on conditioned arrows, and stable ids that connect the drawing to selection and runtime status. Clicking a node, or pressing Enter or Space, selects it for the inspector; node color comes from the newest activation's status. Mermaid loads lazily as this package's private async chunk — about a megabyte over the wire — renders under `securityLevel: 'strict'` with HTML labels off, and zooms inside its own scrolling box. A render Mermaid refuses keeps the generated source and the reason on screen with a retry, because that source is what distinguishes an unsupported definition from a renderer fault.

### Workbench, inspector, and run controls

The dashboard lists the registered projects — title, directory, live directory state, session count, definition revision — and creates, renames, removes, and opens them; opening materializes the project database and switches to that project's workbench. The workbench keeps the canvas central, embeds the coordinator Session as the shared Conversation, lists the decisions the project waits on with a quick-reply field, and shows the run history. The inspector has three tabs: configuration (writable title; read-only kind, source or instructions, memory, output schema, join), tool switches (one switch per registered tool; a declared tool the deployment no longer registers is listed as unwritable), and inputs and results (bindings, output schema, and every attempt of the newest run with the failure it recorded). Python nodes have no switches, and their tab says so. The [interface sketch](2026-10-23-metaworkflow-project-workflows.preview.html) shows that composition with example data; it executes no task and defines no behavior.

`Run` starts a run from the newest revision, `Pause` stops further activations, and `Resume` reopens a paused run. The workbench re-reads the run, the history, and pending decisions on a four-second timer and after each action; there is no run-state subscription. The layout is a container query on the panel's own width: wide frames put canvas and inspector beside the coordinator, and narrow frames collapse to a Canvas/Details/Conversation switch.

### Verified

Each fact below names the suite or command that pins it. Runs are keyless and need no model key.

- The profile, its home isolation, and the first screen: `pnpm exec vitest run packages/bundle/metaworkflow-app` passes `tests/home-guard.spec.ts` and `tests/startup-guard.spec.ts` (unset, blank, and shared homes refused; an explicit home accepted); `packages/client/ui-mw-projects/tests/projects-page.client.spec.tsx` covers the dashboard's loading, empty, failure, and mutation states.
- Project storage and decisions: `packages/workflow/project-store/tests/store.spec.ts`, `open.spec.ts`, `primitives.spec.ts`, and `decisions.spec.ts` cover the registry, one database per project, relocation out of the working directory, serialized writes, and first-answer-wins decision rows.
- Definition and routing: `packages/workflow/definition/tests/validate.spec.ts`, `route.spec.ts`, `join.spec.ts`, and `predicate.spec.ts` cover every validator code, exclusive and multiple routing, fallbacks, loop counting, and both join policies.
- Scheduling: `packages/workflow/scheduler/tests/lifecycle.spec.ts`, `graph.spec.ts`, `waiting.spec.ts`, `concurrency.spec.ts`, `units.spec.ts`, `inputs.spec.ts`, and `transaction.spec.ts`; the transaction suite injects an outbox write failure with a SQLite trigger and asserts that the commit rolls back as one batch.
- Python execution on this Windows host: `pnpm exec vitest run packages/workflow/python-runner` covers interpreter tiers, the project venv, wheels-only install, UTF-8 stdio, the sentinel line, the log cap, and deadline termination of the process tree; `packages/workflow/python-executor/tests/executor.spec.ts` and `restart.spec.ts` cover kind registration, the retryable timeout, and restart.
- Agent nodes: `packages/workflow/agent-executor/tests/composition.spec.ts`, `completion.spec.ts`, `decisions.spec.ts`, `sessions.spec.ts`, and `outcomes.spec.ts`, plus `agent-node.e2e.ts`, cover composition, the allow list, retained and fresh memory over a loop edge, completion, the waiting outcome, and failure mapping.
- Coordinator decisions: `packages/workflow/coordinator/tests/coordinator.spec.ts` has a node ask a decision and a coordinator turn answer it, then asserts that the run settles.
- Tool switches and the inspector: `packages/api/workspace-controller/tests/projects-workflow.host.spec.ts` covers `projects.availableTools` and `projects.updateNode`; `packages/client/ui-mw-projects/tests/workbench.client.spec.ts` covers selection, title edits, tool toggles, run control, decision answers, and the polling reads.
- Mermaid import and the canvas: `packages/workflow/mermaid-import/tests/parse.spec.ts`, `definition.spec.ts`, and `index.spec.ts`; `packages/client/ui-mw-projects/tests/mermaid-graph.client.spec.ts`, `workflow-canvas.client.spec.tsx`, and `import-dialog.client.spec.tsx`.
- The coordinator conversation in the workbench: `packages/client/ui-mw-projects/tests/coordinator-conversation.client.spec.tsx` renders the shared Conversation content as an embedded chat.

## Settled constraints

These hold as later work extends the product.

- **No new `SessionEventMap` members.** Runs, activations, attempts, iterations, edge routing, and revisions live in the project database. Sessions carry model-visible history only, so scheduling adds no model-visible input and no persisted event type.
- **Recovery stops at the last committed exchange.** There is no restoration to the middle of a tool call. After a crash, `agents.resume()` synthesizes an `isError` result for each unsettled tool call (`TOOL_OUTCOME_UNKNOWN` when execution may have started, `TOOL_NOT_STARTED` when it did not), and the model decides again from that result.
- **A node's tools are a capability selection, not a permission system.** `restrict({ allow })` filters what the child receives; it grants nothing and does not narrow or widen what another tool may do. Every child still runs with the host user's authority.
- **Node directories organize work; they do not confine it.** A Python node may install wheels, reach the network, and read or write ordinary host files. Process termination is ownership, not a sandbox, and a killed node may already have changed a file or called a remote service.
- **Client copy is locale-owned.** Strings go through the locale dictionaries with Chinese as the authored side, as `verify-client-ui-i18n` requires.
- **Package placement and naming.** Workflow capabilities live under `packages/workflow/` with the `workflow-*` prefix, and the client package is `ui-mw-projects`; neither collides with the existing `ctx.workflowEngine` seam or `ui-workflow-run`.

## Alternatives considered

**Extend the Desktop application, or rework the shipped `web` profile.** A browser-only product on its own profile and bundle keeps the Desktop product's interface and data unchanged, and lets the two change separately. The cost is a second bundle to maintain.

**Separate design and execution coordinators.** One Agent and one continuing conversation owns both responsibilities. Splitting them would duplicate context and obscure who decided what.

**A catalog of fixed program operators.** AI-authored Python functions express arbitrary logic; a fixed branch-and-loop operator catalog would have limited the workflow to the operators we shipped.

**Nodes return successor IDs.** Routing conditions live on graph connections, so the visible graph explains execution and a result cannot steer control flow through a field named `next`.

**Shared node workspace or combined memory.** Each node has its own working directory and its own memory policy, with explicit data exchange; shared state would make two nodes' inputs and history depend on each other without a record.

**Apply changes only on the next run.** The intent was to pause affected activations and continue the current run with the change. The shipped scheduler instead reads one revision per run and refuses a mid-run edit as `scheduler/stale-result`; applying edits to a live run stays unbuilt rather than silently approximated.

**Reuse the documentation site's Mermaid renderer.** That renderer is a Vue component for VitePress, so it cannot run in the client plugin; the client carries its own Mermaid chunk.

**Reuse `mwf-workspace`'s project list as the project model.** It owns directories and their Sessions but no workflow definition, run, or attempt. Identity moved to the project store, and the workspace registry now groups Sessions over that identity instead of holding a second project concept.

## Consequences

The product is one browser surface, so Desktop users and the `web` profile are unaffected — and the workflow experience does not exist in either. The second bundle is a fork of the Web rows rather than a shared composition, so a Web-surface change must be ported deliberately.

Durability and inspectability cost a write path: every run, activation, attempt, artifact, decision, and outbox row lives in SQLite, and each project opens one database. The outbox keeps Session writes ordered after the state row that produced them, but a crash between the two leaves the event unacknowledged, not lost, and nothing retries it automatically.

Python is deliberately unrestricted. A node runs with the host user's authority, so it can break the machine or reach the network; separate node directories are organization, not confinement. A killed function or tool call may already have had external effects; the durable commit prevents duplicate scheduler acceptance, not exactly-once external side effects.

The canvas pays for its renderer: Mermaid ships as this package's private async chunk of about a megabyte over the wire, loaded lazily on the first project. A second surface that drew definitions would carry its own copy, and the canvas redraws the whole diagram on every revision rather than diffing the source.

The workbench reflects state on a four-second poll. `projects.startRun` returns when the scheduler stops dispatching, so a long agent node keeps the request open instead of streaming progress, and a decision or a node color can appear up to one interval late. A run-state subscription is the missing piece.

One revision per run is the largest gap in the shipped scope: structural editing, coordinator-driven repair, and version-consistent reruns of affected activations are not implemented. The coordinator can answer decisions, list them, and report project state, but its Session carries no definition-editing tools, and the inspector writes only the node title and its tool list; source, instructions, schema, inputs, and edges stay read-only.

Edges and loops are scheduler features, not import features: a back-edge must be authored after import, because a cyclic flowchart is refused. A first-success join can also starve a target whose input is bound to a branch that never committed, reporting `scheduler/input-missing`.

Two smaller costs belong to the split. A retained node Session is never compacted by its executor, so a long project relies on the deployment's compaction policy; deleting a project leaves the coordinator Session log behind, and its database and files stay unless removal explicitly deletes the directory.

## Related

The [PTC sandbox decision](../architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) still owns the JavaScript orchestration runtime and its sandbox; this work adds a separate Python execution path and changes nothing there.

The [domain KV storage and workspace proposal](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) remains proposed for the storage domain form it records. Its premise that the workspace entity owns project path, title, and identity is only partly what shipped: identity, directory, and title now come from `@metaworkflow/workflow-project-store`, and the workspace registry adds the session account over that identity. The proposal stays active and cross-linked rather than archived, because its storage-domain rationale is still current.

The [archive-stops-running-work decision](2026-09-21-archive-stops-running-session-work.md) keeps the archive semantics the workspace registry applies to Session membership.

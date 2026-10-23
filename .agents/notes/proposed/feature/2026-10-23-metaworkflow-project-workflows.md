# Agent Note: MetaWorkFlow project workflows

Status: proposed

English | [中文](2026-10-23-metaworkflow-project-workflows.zh.md)

## Problem

The requested fork rebuilds the existing MWF Web application around workflow project management. The home page manages projects; each project contains its workflow canvas, coordinator conversation, node capabilities, and execution results. Users import a Mermaid flowchart, develop the executable workflow through conversation, and run independent MWF Agents and Python functions with durable progress. Novel generation is the first example; coordinator decisions, revision loops, and recovery are specified below without external product references.

This note records confirmed requirements and proposed implementation details for user review. It does not claim that the feature is implemented. Implementation starts only after the user approves the proposal.

## Proposal

### Confirmed product scope

- Run locally in a browser through the dedicated `metaworkflow` profile. Substantially redesign the existing pages into a workflow project management application. Open on the project dashboard; within a project, use the workflow canvas as the main view with an embedded coordinator conversation and selectable nodes showing configuration, inputs, outputs, and execution history.

- One project represents one independent workflow. Support concurrent projects and concurrent branches within a workflow. Each project owns its definition, files, coordinator memory, and execution history.

- Import a Mermaid graph containing step names and connections. The coordinator generates node implementation, prompts, output definitions, input mappings, and edge conditions, then accepts further changes through conversation.

- AI task nodes use configurable MWF Agents, including models, instructions, tools, skills, and memory. Models can differ between nodes and the coordinator. Each AI node has its own list of tools, each with an enable/disable switch. A node either reuses its own continuing conversation across activations or starts a fresh one each time; reuse is the default.

- Program nodes execute AI-authored Python functions, rather than requiring a fixed catalog of built-in operators. Python may use third-party libraries, network services, and ordinary host filesystem access without an application sandbox.

- Each node has its own working directory and exchanges explicit results and files with other nodes. Separate directories organize execution; they do not impose filesystem confinement on unrestricted Python.

- Support pause, continue, retry, single-step execution, and recovery after application restart. User-facing checkpoint rollback is outside the first release.

### Web pages and navigation

Project management becomes the application's top-level organization. Rework the Web shell, navigation, home page, and main actions around projects and workflow runs. The result is browser-only, launched as `mwf metaworkflow`, and carries its own profile and bundle; the Desktop product keeps its current interface and data (the verified constraints and design decisions section states that split). Existing MWF conversation, tool, file, and Session capabilities become parts of the project experience. Reuse their services and suitable components while changing where and how users reach them.

| Page or panel | Main responsibilities |
| --- | --- |
| Project dashboard | Create a project, import Mermaid, list independent workflow projects, show each project's run status and progress, and open or switch projects. |
| Project workbench | Keep the canvas central; provide run, pause, continue, and step controls; embed the project's coordinator conversation alongside the workflow. |
| Node inspector | Show Python source or Agent configuration, inputs, output definitions, memory, tool activity, execution history, and produced files for the selected node. |
| Project results and history | Browse run records, inspect failures and decisions, and open the files and results produced by the workflow. |
| Application settings | Reuse configuration for models, credentials, tools, and skills, and add the Python execution settings needed by workflow projects. |

The coordinator conversation remains attached to the current project when a node is selected. Node Session details open in the node inspector, keeping node execution context distinct from the coordinator's continuing conversation. Switching projects restores that project's canvas, conversation, and run state. Sessions serve coordinators and nodes; they do not become additional workflow projects.

The table proposes page responsibilities; whether node details, results, and history use tabs, drawers, or panels remains an implementation choice. Reuse MWF visual tokens, localized controls, and existing conversation renderers. On narrow screens, switch between canvas, conversation, and details instead of squeezing all three into unreadable columns.

The [interface sketch](2026-10-23-metaworkflow-project-workflows.preview.html) shows this page composition with example data; it executes no real task and defines no behavior.

### One coordinator per project

The conversation panel connects to the project's single persistent coordinator Agent. The same Agent designs the workflow, writes Python, configures AI nodes, answers decision requests, diagnoses failures, and repairs nodes. There is no separate design Agent. The coordinator has full operating authority within the project directory and does not request routine human approval for node repairs.

Preserve the previously agreed distinction between autonomous node repair and user-directed structural editing: the coordinator can repair code, prompts, inputs, and configuration autonomously; adding or deleting nodes and changing connections follows the user's conversation request. Review can explicitly broaden this rule.

AI nodes send decision requests through a tool. A request returns immediately with `{status: 'pending', requestId}` and concludes that node's turn, so the attempt enters `waiting` and releases its execution slot: a group of waiting nodes cannot prevent the coordinator from running. Requests and coordinator responses are durable and associated with the requesting attempt; a delivered decision continues the same attempt. The coordinator can inspect all project node histories and artifacts.

### Per-node tool switches

Each AI node's inspector includes a tool list showing each available tool's name, description, and enabled state. Users toggle tools individually; the node receives only the enabled tools. For example, a user can keep file reading enabled and turn file editing off. Settings are independent across nodes and persist with the workflow definition.

These switches select tools only. They do not infer permissions, automatically disable related tools, or add restrictions to other enabled tools. Users decide which combinations to enable. The existing unrestricted Python-node design remains unchanged.

Proposed implementation: save an explicit `allow`/`deny` selection per node and apply it to that node's Agent through `ctx.tools.restrict()`, which only accepts an agent-scoped context. The task-completion tool is new in this work — none of the 27 `tool-*` packages provides a completion or wrap-up tool — and every AI node receives it as a required, always-enabled workflow control, labelled as such in the list. Runtime tool changes already appear as `developer/message` events, so the switches add no persisted type and infer no permissions. Changing a running node's tools follows the versioned editing procedure below; it does not change other nodes' selections.

### Node input and completion

A Python node exports `nodemain_<id>(inputs)`. The input is a dictionary assembled from declared upstream fields, artifact references, and run parameters. The function returns a JSON string. The runner parses and validates it before committing the result; diagnostic stdout and stderr are recorded separately and are never treated as the return value.

```python
import json


def nodemain_check(inputs):
    review = inputs["review"]
    return json.dumps({
        "passed": review["passed"],
        "issues": review["issues"],
    }, ensure_ascii=False)
```

An AI node performs its work through MWF tools and finishes by calling a task-completion tool with JSON matching the node's declared output. Ordinary assistant prose does not complete the workflow node. Invalid completion returns actionable validation errors to that Agent; only accepted completion advances scheduling. Business decisions such as review acceptance remain in Python nodes and edge conditions.

Proposed implementation: the coordinator derives an editable output schema from each node's task instructions and uses it for the completion tool and runtime validation. The completion tool copies the `structured_output` pattern from subagent runs: schema-check the submitted value, backfill it through a `tools/post-execute` block, commit it with `concludeTurn`, and guard repeated or missing completion. Both node kinds yield a validated JSON value to the scheduler, while the Python author-facing return remains a JSON string. Repair limits and execution limits are explicit configurable values.

### Edges, loops, and parallel joins

Connections select successors from returned business fields; a node does not return a next-node ID. A result such as `{"passed": true}` activates the edge whose configured condition matches it. Input mappings and conditions remain inspectable from the canvas, and the coordinator writes them during import or conversation.

Proposed first-release semantics: unconditional fan-out starts all connected branches; conditional outgoing edges declare exclusive or multiple-match routing; exclusive routing rejects ambiguity, and an unmatched condition reports a routing error unless an explicit fallback exists. Condition editing uses a small typed predicate representation instead of arbitrary browser or host evaluation.

Support back-edges for loops. Each activation belongs to a run and loop iteration, so a result from an earlier iteration cannot satisfy a later join. Join policy is configurable per node: wait for all activated branches by default, or accept the first successful branch. Unselected conditional branches are excluded from the expected set. A first-success join fires once; remaining branch handling is an explicit policy and never causes a duplicate downstream activation.

### Files, persistence, and recovery

Proposed storage keeps one `project.db` per project (node:sqlite, measured working under Electron 44.7 / Node 24.21) plus a small global registry database, and mounts neither through a storage-domain static route. Each database opens once per backend process and keeps one writer connection: the open sets WAL journal mode, a busy timeout, and foreign keys, and the scheduler, the outbox writer, and readers share that connection instead of opening their own. The project database holds scheduling state and references; files hold node source and immutable published artifacts; existing MWF Session persistence retains model-visible tool and message history. Runs, activations, attempts, iterations, edge routing, and definition revisions stay out of the Session event map, which gains no members.

At dispatch, capture the exact definition revision, node implementation, input values, and artifact versions. Materialize the declared input files in the receiving node's workspace. Published artifacts retain stable versions so a later local file edit cannot silently change an earlier result or another node's input.

Node acceptance and downstream scheduling are committed together. Pause cancels affected in-flight attempts; MWF has no pause primitive, so continuing starts a new turn or resumes a Session, and retry creates a new attempt. Single-step executes one selected ready activation, then pauses scheduling. For parallel workflows, the UI makes the selected activation explicit. The scheduler owns its execution slots because MWF has no global concurrency pool.

Closing a browser tab does not stop the local backend. After backend restart, runs reopen paused with interrupted attempts identified. Continue resumes AI work only to the last committed assistant/tool exchange: `agents.resume()` synthesizes an error result for every unsettled tool call (`TOOL_OUTCOME_UNKNOWN` when the call may have started, `TOOL_NOT_STARTED` when it did not), and the model decides again from that result. Python functions restart from their entry point. The scheduler neither repairs the Session tail nor relies on the Session for exactly-once. Arbitrary Python instruction-level recovery is not part of this proposal.

### Apply edits to an active run

The user selected applying edits to the current run. The coordinator proposes a concrete change and affected-node set, pauses those attempts and dependent downstream work, waits for them to stop, saves the new revision, and resumes the required activations. Unaffected parallel branches may continue.

The coordinator determines the rerun set and records the reason. The scheduler enforces dependency and version consistency: consumed inputs must remain valid, obsolete attempts cannot publish results, and changes cannot mix incompatible node revisions within one activation. Historical results remain available; superseded results are marked rather than overwritten. If the coordinator's affected set is incomplete, the scheduler returns the missing dependencies for correction.

### Canvas and authoring

Mermaid rendering is a new browser dependency. The repository declares `mermaid` 11.17.2 only as a root and website devDependency, and the Web bundle does not integrate it; the documentation site's renderer is a Vue component for VitePress and cannot be reused in the client, so the renderer is newly written inside the MetaWorkFlow client plugin. The layout should be compact, with short node labels, balanced grouping, zoom and pan, and MWF-compatible colors and typography. Select layout options against actual graphs rather than promising that any renderer eliminates long chains. Stable node IDs connect rendered elements to inspectors and runtime status.

Proposed authoring model: a structured workflow definition is authoritative after import; Mermaid is an import and display representation. The coordinator preserves node identity during ordinary edits. Click a node to inspect or edit its Python, Agent configuration, memory policy, inputs, output schema, attempts, and artifacts. The first release does not require a separate drag-and-drop wiring editor.

The default authoring check validates graph references, input mappings, conditions, Python syntax, and output definitions, then runs mock inputs through the workflow. A normal Run action uses the configured real models. Mock validation demonstrates scheduling and data flow, not the quality of real model output.

### Verified constraints and design decisions

These decisions resolve the implementation questions the sections above leave open and record what the repository and the user's Windows host actually provide.

- **Product scope: browser only.** The application ships as its own `metaworkflow` profile plus an independent bundle copied from the Web bundle and reworked, and starts as `mwf metaworkflow`. The Desktop product is an existing MWF product: it keeps its current interface and data, and this work changes nothing in Desktop. `PROFILE_TEMPLATES.web` keeps its current bundles.

- **Data isolation.** `MWF_HOME` points at a separate root inside the repository (for example `<repo>\.mwf-home`), and the backend never reads or writes `~/.mwf`. The first `mwf metaworkflow` initializes `$MWF_HOME/profiles/metaworkflow` directly from the shipped template. `--from-default-profile` only resets a custom profile name to a copy of a shipped template and rejects a shipped name, so it is not part of this setup (see `apps/cli/src/profile-boot.ts:126` and the [`--from-default-profile` upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.2/from-default-profile-replaces-target/guide.md)). `MWF_HOME` stays a per-terminal environment variable; a permanent value would also move the Desktop product's home, so it is never set globally. `MWF_AGENTS_HOME` is set as well when the shell exports one.

- **Recovery stops at the last committed exchange.** There is no restoration to the middle of a tool call. After a crash, `agents.resume()` synthesizes an `isError` result for each unsettled tool call (`TOOL_OUTCOME_UNKNOWN` when execution may have started, `TOOL_NOT_STARTED` when it did not), and the model decides again from that result. Recovery reaches only the last committed assistant/tool exchange.

- **No new `SessionEventMap` members.** Run, activation, attempt, iteration, edge routing, and revision state live in the project database. Sessions carry only model-visible history, so the scheduler adds no model-visible input and no persisted event type.

- **AI nodes are coordinated child Agents.** Each node runs as a subagent Session with `parentSession` set and `origin: 'subagent'`, assembled through the existing child-agent composition, and cold recovery replays its versioned descriptor the same way a subagent run does.

- **Tool switches are `ctx.tools.restrict()` filters.** A node's saved selection becomes an `allow`/`deny` filter on its agent-scoped context; the call rejects a context-global filter, an empty filter, and reserved presentation transport names. Selections grant no permissions, and runtime changes already land in `developer/message` events.

- **Memory is Session reuse, not a compaction setting.** "Retained with compaction" and "fresh each time" describe whether a node reuses one Session across activations or starts a new one per activation. Compaction is one service per composition, configured per provider and model, so it applies to a reused node Session like any other conversation and cannot be toggled per node.

- **The completion tool copies `structured_output`.** It validates the submitted JSON against the node's output schema, backfills the accepted value through a `tools/post-execute` block, commits with `concludeTurn`, and keeps a guard against repeated or missing completion.

- **Decision requests answer immediately.** The tool returns `{status: 'pending', requestId}` and calls `concludeTurn()`; the attempt becomes `waiting` and frees its slot. A delivered decision continues the attempt through `followup()` or `resume()`.

- **There is no pause primitive.** Pausing cancels the attempt; continuing starts a new turn or resumes the Session. MWF has no global concurrency pool, so the scheduler creates and owns its execution slots.

- **Python execution.** Each project has one virtual environment and a configurable interpreter (CPython 3.10–3.14, excluding free-threaded 3.14t). Installs pass `--only-binary=:all:` because the host has no MSVC toolchain and any sdist build fails. Inputs travel as UTF-8 JSON on stdin rather than argv; the result is one stdout sentinel line `__MWF_RESULT__ <json>` that is never subject to the truncating log buffer. The child environment sets `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, and `PYTHONUNBUFFERED=1`, because a default GBK locale mangles output silently and raises on emoji. `child.kill()` leaves orphans, so termination falls back to `taskkill /T /F`, with an optional PowerShell Job Object supervisor (`KILL_ON_JOB_CLOSE`, breakaway disabled) for long runs. Project root paths stay below 200 characters because a venv fails at 277 characters or more.

- **Storage consistency.** An in-database outbox (`attempt_id, event_seq, payload, acked_at`) commits in the same `BEGIN IMMEDIATE` transaction as the attempt result and its state transition. A single writer appends the Session event and then backfills `acked_at`; the idempotency key is `(attempt_id, event_seq)`; the Session is never written before the state row. Cross-project reads use read-only `ATTACH`, and no transaction writes two databases.

- **Client copy is locale-owned.** Client strings go through the locale dictionaries, with Chinese as the authored side and English kept in step, as `verify-client-ui-i18n` requires.

- **Naming.** New packages use the `mw-*` and `ui-mw-*` prefixes so they cannot collide with the existing `ui-workflow-run` or `packages/workflow`.

### Integration and implementation sequence

The [workflow reference](../../../../packages/workflow/workflow/README.md), in its Summary, documents caller-owned JavaScript runs without saved workflows or resumable execution. The experimental [Python runtime](../../../../packages/experimental/ptc-runtime-python/README.md#known-limitations-and-deferred-work) documents an execution host limited to Unix and rejects a non-Unix platform at load. These are documentation facts, not local runtime validation. This proposal requires durable graph scheduling and a Python function runner that supports the user's native Windows host.

Use Cordis plugins and existing [Agent scopes](../../../../packages/core/agent/README.md), [local subprocess management](../../../../packages/subprocess/subprocess-local/README.md), presets, tools, Session persistence, [compaction](../../../../packages/compaction/compaction/README.md), and `@metaworkflow/workspace`, which already owns a project concept: a durable list of project directories and the Sessions run in each. Add project storage, scheduler, node executors, and coordinator tools as owning capabilities, and recompose the Web application around the project dashboard and project workbench. Launch through the dedicated profile and bundle with the isolated Harness home described above. Plugin reuse describes the internal implementation; the user-facing scope includes replacing the existing session-oriented navigation and page organization. Exact package names and persisted type definitions remain implementation details for review.

The existing [workflow PTC decision](../../implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) remains applicable to the current JavaScript workflow implementation. This proposal adds a project workflow capability with a distinct Python execution choice; it does not supersede or alter that existing decision. The scoped active-note search found no existing owner for workflow projects; `mwf-workspace` owns a project-directory concept, and this proposal extends and rewrites that ownership. No notes are archived.

1. M1 skeleton: the `metaworkflow` profile, auto-initialized from the shipped template on the first `mwf metaworkflow`, its bundle copied from the Web bundle, an isolated Harness home, the project dashboard, and a launch guard that refuses to start unless the home is the MetaWorkFlow one.

2. M1: project storage in two schema steps (v2, then v3), so the schema is reviewed before it freezes.

3. M1: navigation and the project workbench — create, open, and switch projects before expanding execution features.

4. M2: the workflow definition, validation, input mappings, and the Python function executor; demonstrate conditional routing with deterministic fixtures.

5. M3: persistent scheduling, loop iterations, concurrent joins, cancellation, single-step behavior, restart recovery, and rejection of late results.

6. M4: the three Agent-node parts — Agent composition and memory, the completion tool, and per-node tool switches — plus the single project coordinator with decision and repair tools, embedded in the workbench with node capabilities in the inspector.

7. M5: Mermaid import and rendering, conversation editing, results and history views, and version-consistent updates to running workflows.

8. M6: browser acceptance of the complete workflow with a compact example; add a novel-writing template after the general mechanisms work.

## Alternatives considered

**Extend the Desktop application, or the shipped `web` profile in place.** The user chose a browser-only application on its own profile and bundle, so the Desktop product keeps its interface and data and the new backend runs under an isolated home.

**Separate design and execution coordinators.** The user requires one Agent and one continuing conversation for both responsibilities, so splitting them would duplicate context and obscure ownership.

**A catalog of fixed program operators.** The user selected AI-authored Python functions for arbitrary logic. Built-in branch and loop operator catalogs are not the required programming model.

**Nodes return successor IDs.** The selected design keeps routing conditions on graph connections so the visible graph explains execution.

**Shared node workspace or combined node memory.** The selected design gives each node its own workspace and configurable memory, with explicit data exchange.

**Apply changes only on the next run.** The user selected pausing affected work and continuing the current run with the changes. Immutable attempt inputs and recorded revisions make that behavior inspectable.

## Acceptance criteria

- `mwf metaworkflow` opens the project dashboard in a browser. Create and open a project, then use its canvas, embedded coordinator conversation, node capabilities, and results within the project workbench. Switching projects preserves their independent context and running state.

- Import a small Mermaid graph, let the coordinator fill executable definitions, inspect them in the browser, and modify the graph through the same conversation.

- Configure different tool selections for two AI nodes. Verify that each node receives only its selected tools and the required completion tool, settings survive reopening the project, and changing one switch does not alter other tools or nodes.

- Run Python functions with mapped dictionaries and JSON-string returns on native Windows. Verify file exchange, dependency use, the per-project virtual environment, and independent node working directories.

- Run an AI draft node, two parallel review nodes, a Python aggregation and routing node, and a revision back-edge. Force one rejected review and one malformed completion to verify correction and loop progress.

- Run two independent projects concurrently. Exercise all-activated and first-success joins, unselected branches, and repeated loop activations without duplicate downstream dispatch.

- Pause, step, retry, and restart the backend during execution. Recover completed results and pending decisions, identify interrupted work, and continue without accepting obsolete attempts; a resumed node sees `TOOL_OUTCOME_UNKNOWN` or `TOOL_NOT_STARTED` for the interrupted call instead of a fabricated success.

- Introduce a failing Python node and let the coordinator repair it autonomously. Request a structural edit during another run and verify affected-node pause, recorded revision, dependency-consistent reruns, and retained history.

- Use keyless fixtures for scheduler and tool behavior, recorded Sessions for model-visible changes, and a real-model browser smoke for end-to-end verification. Record actual checks separately from these planned criteria.

- Finish the full run and verify that `~/.mwf` gained no files, settings, or Sessions, that the backend used the repository-local home, and that the Desktop product opens with its own project list, settings, and Sessions unchanged.

## Risks

Unrestricted Python and full project authority are intentional requirements. Separate working directories are organizational, not a security guarantee. Process supervision remains necessary for cancellation and cleanup and must not be described as sandboxing.

A killed Python function or external tool may already have changed a file or called a remote service. Durable result commits prevent duplicate scheduler acceptance, but cannot guarantee exactly-once external side effects. Attempts retain identifiers and diagnostics so repairs can reconcile outcomes before retrying.

Runtime editing and configurable joins are the main consistency risks. Acceptance tests must cover changes during in-flight tool calls, unchanged parallel branches, stale completions, loop iterations, and restart between result acceptance and successor dispatch.

Isolation depends on `MWF_HOME` reaching only the MetaWorkFlow backend. A permanent export would redirect the Desktop product to the MetaWorkFlow home, so the launch guard compares the resolved home and refuses to start on a mismatch, and acceptance verifies `~/.mwf` instead of trusting the guard alone.

The Mermaid renderer is newly written client code with no Web integration to start from, and the repository has no earlier `prototypes/` directory, so the sketch is a static HTML file with example data rather than a shipped page.

The illustrative workflow, storage layout, condition representation, schemas, and milestone ordering are implementation recommendations. The user-confirmed product scope remains authoritative during review; no runtime implementation is included in this documentation change.

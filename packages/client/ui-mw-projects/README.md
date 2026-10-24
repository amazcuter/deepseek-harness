---
description: "MetaWorkFlow project surfaces: the dashboard main panel and sidebar entry that list the Host's registered workflow projects, and the project workbench a project opens onto with its stored definition, node inspector, tool switches, run controls, and pending decisions."
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

English | [中文](README.zh.md)

## Summary

The MetaWorkFlow profile opens on a project dashboard instead of the previous Session. It lists the registered projects — one row per independent workflow, with its directory, live directory state, session count, and definition revision — and creates, opens, renames, and removes them through the `projects` Remote namespace. Opening a project switches to its workbench: the nodes of its newest stored definition, the inspector with each node's tool switches and execution record, the run controls, and the decisions the coordinator owes. The package also publishes the startup policy that keeps the first screen on the dashboard.

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

`mwf metaworkflow` opens the dashboard. The page names the profile's home, explains that each project holds one independent workflow, and shows the loading skeleton, the load failure, the empty state, or the project list.

### Loading, empty, and failure states

The first screen is a three-row skeleton until the Host answers; it carries the localized loading label and `aria-busy`. With no registered projects the dashboard offers **New project**. When the list call fails, the panel shows the localized reason for the failure code, the Host's own diagnostic below it, and a **Retry** button that reissues the call.

### Creating a project

**New project** registers a project whose title is the localized “Untitled project”; the Host decides its directory under the Harness home. The row appears as soon as the Host echo arrives, then **Rename** gives it a real name. **Import Mermaid** ships as a disabled placeholder: importing a flowchart is not implemented yet.

### Project rows

Each row shows the title, the absolute project directory, the live directory state (`Directory ready` or `Directory missing`), and a line with the project's session count and definition revision.

- **Open** calls `projects.open`, which materializes the project database when the directory exists without one. Once the Host answers, the composition switches the main column to that project's workbench; the row keeps the `aria-current` mark and the panel names the open project, so returning to the dashboard reads which one is current.
- **Rename** swaps the title for an inline editor. Enter or **Save** commits the trimmed title, Escape and **Cancel** discard it, and a blank draft cannot be saved.
- **Delete** first asks in place: the confirmation names the project and repeats that only the registration is removed. The project directory and every Session stay on disk; the panel repeats that below the list.

A mutation in flight disables the row controls and the create action. A failed mutation leaves the list untouched and shows the localized reason with the Host diagnostic above it.

A narrow frame stacks each card — Host facts first, then the actions on their own line — so nothing needs horizontal scrolling.

### The project workbench

Opening a project selects its workbench panel. The header carries **Back to projects**, the project title and directory, and **Switch project**, which lists every registered project and marks the one on screen; choosing another calls `projects.open` and stays on the workbench. A failed switch keeps the current project on screen and reports the reason in place.

Three regions read the project's newest stored definition through `projects.definition`:

- **Workflow canvas** — one row per definition node in document order, each with its kind and the state of its newest activation. **Run** starts a run from the newest revision (the Host validates the stored document, creates the run, and advances it once), **Pause** stops further activations, and **Resume** restarts a paused run. All three are disabled without an executable definition, and the note under them says why; a stored document that no longer validates lists its violations instead of nodes.
- **Node details** — the inspector for the node selected in the canvas, across three tabs. **Configuration** shows a writable title beside the read-only kind, Python source or agent instructions, memory policy, output schema, and join. **Tool switches** lists one switch per tool the Host registers plus any name the node still declares, each write going back through `projects.updateNode` and re-reading the definition. **Inputs and results** shows the node's input bindings, its output schema, and every attempt of the newest run with the failure each recorded. A Python node has no tool switches, and its own copy says so.
- **Project coordinator** — the decisions the project waits on: the node that asked, its question, the choices it proposed, and a quick-reply field that answers through `projects.answerDecision`. **Refresh** re-reads them. **Open the coordinator Session** shows that Session in the shared conversation view.

A wide frame puts the canvas and the inspector in the middle column with the coordinator beside them. A narrow frame collapses to one column and shows a **Canvas** / **Details** / **Conversation** switch, so the three columns never squeeze into each other.

### Startup policy

The plugin publishes `sessionRestorePolicy` with `restoreLastSession: false`. [ui-workspace](../ui-workspace/README.md) owns that optional policy contract: with the policy absent, startup reopens the previously selected Session; with it set to `false`, startup leaves the first screen to the dashboard the composition selected. The dashboard selects its own main panel once per activation, so the profile lands on the project home rather than on a conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers two keyed `main` panels — `projects` and `project` — from one `ctx.slots.inject` generator, so both appear and disappear with the same declaration, plus one `sidebar.panellist` entry that carries the `projects` id so the sidebar can return to the dashboard after a Session is opened. The generator shares one open callback between the panels: only the dashboard row and the workbench switcher call it, and the workbench is selected after the Host confirms the open. A call that settles after the contribution collapsed is dropped rather than selecting a panel that no longer exists.

`ProjectsController` is the React-free object layer over `ctx.remote.projects`. It owns one `ProjectsSnapshot` — the list state (`loading`, `ready`, or `error` with its failure), the rows, the selected project, the last mutation failure, and the in-flight flag — and publishes it as a bare observable. Every mutation updates the snapshot from the Host's echo, never from an optimistic local draft; a call that rejects is folded into the same failure codes instead of escaping as an unhandled rejection. `open()` additionally reports whether the Host opened the project, which is what lets the composition navigate only on success. The plugin starts the first load with the composition and hands the observable to both panels through the inject `hooks` compartment, so each component reads `useProjects` and calls its own injected callbacks.

`WorkbenchController` is the second React-free object layer, over the same namespace. It owns one `WorkbenchSnapshot` — the coordinator Session identity, the definition with its violations, the selected node, that node's tool switches, the pending decisions, the newest run with its activations, and that run's attempts — and publishes it as a bare observable. `open()` replaces the whole snapshot and reads the four verbs in parallel, and a generation counter drops a slower earlier read so a project switch cannot publish stale nodes into the project now on screen. Every edit and every run control goes through `mutate()`, which publishes the in-flight flag, folds the failure into the snapshot, and then re-reads the definition and the node it kept selected.

The components keep local state only: which row is being renamed or confirmed on the dashboard, and the narrow-frame section, the node tab, the title draft, the decision reply drafts, and the project menu on the workbench. Copy lives in the `mw.projects` dictionary registered with `client-locale`, with Chinese as the authored side; the failure-code-to-copy table is shared by both panels in `failures.ts`. The locale files under `locale/` carry only plugin display metadata.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-layout](../ui-layout/README.md) — the frame that owns the keyed `main` slot.
- [ui-sidebar](../ui-sidebar/README.md) — the panel list this entry joins.
- [ui-primitives](../ui-primitives/README.md) — the buttons, tab strips, segmented control, and menu both panels compose.
- [ui-workspace](../ui-workspace/README.md) — the startup policy consumer and Session navigation.
- [api-workspace-controller](../../api/workspace-controller/README.md) — the Host `projects` Remote namespace this dashboard reads.
- [metaworkflow-app](../../bundle/metaworkflow-app/README.md) — the profile bundle that mounts this plugin and refuses a shared Harness home.

-----

<a id="model-experience"></a>
## Model Experience

### Project dashboard panel

#### What the model sees

No model-visible input. The package renders browser-only project state in the `projects` main panel and contributes no prompt text, tool schema, or request context.

#### Token effect

Zero direct effect on model requests; only the composition that mounts the package can change what the agent sees.

#### KV Cache effect

No effect: the package never adds to, replaces, or reorders model context.

### Project workbench panel

#### What the model sees

No model-visible input. The `project` main panel renders the selected project's stored definition, tool switches, decisions, and run state; **Open the coordinator Session** only navigates to a Session another surface already renders, so nothing here reaches a request.

#### Token effect

Zero direct effect on model requests.

#### KV Cache effect

No effect: no prompt text, tool schema, or request context is added, replaced, or reordered.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No live list stream** — the dashboard reloads on activation and patches rows from mutation echoes; another window's registration appears only after a reload.
- **Import does not parse Mermaid yet** — the action ships disabled; parsing, rendering, and the coordinator flow arrive with the workflow-definition milestone.
- **The coordinator conversation is not embedded** — the workbench shows the decisions the project waits on and links into the shared conversation view instead of hosting the `conversation.content` factory. That factory needs a session-scoped child slot, which a `main` panel cannot declare: ui-layout owns the `main` SlotMap entry and it carries no children, so declaring one here would mean hand-writing a derived prop share. Open question: a workbench-owned session-scoped slot in ui-layout.
- **A run start waits for the first tick** — `projects.startRun` returns when the scheduler stops dispatching, so a long agent node keeps the request open instead of streaming progress. A run-state subscription is the follow-up.
- **Decisions are polled, not pushed** — the workbench re-reads `projects.pendingDecisions` on a four-second timer, after each action, and on **Refresh**, instead of subscribing to `workflow/decision-requested` and `workflow/decision-answered`. A decision therefore appears up to one interval late.
- **Only the title and the tool list are writable** — instructions, source, schema, inputs, and edges stay read-only in the inspector; the coordinator Session owns those edits.
- **The workbench keeps no per-project view state** — switching projects preserves the section and node tab on screen, and nothing survives a reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Six mechanisms carry this package, so moving one means revisiting the others. The Remote owns the data: rows, mutation echoes, and failures all arrive through `ctx.remote.projects`, and a Host that answers slowly is never a reason to keep a local draft. `ProjectsController` is the only writer of the snapshot — `load()` moves `loading` to `ready` or `error` once, every mutation overlays `busy` and `mutationError` on that list state, and `busy` counts in-flight calls so overlapping mutations keep the controls disabled until the last settles. The ready gate keeps creation and row mutations disabled while `view.status !== 'ready'`, because a failed load has no rows to patch. Both failure forms fold into one `ProjectFailure`, and the shared code-to-copy table needs a key for every code the namespace can raise. Copy lives in the `mw.projects` dictionary with Chinese as the authored side; `locale/*.json` carries display metadata only.

The workbench panel is a consumer of the same snapshot rather than a second controller: it derives the open project from `openedProjectId` and renders the project list's empty state when that id is gone, which is what a removal leaves behind. Its narrow-frame layout is a CSS container query on the panel's own width plus a local section value, so the width decision never depends on the window and the sidebar's presence cannot squeeze the three columns; the `data-active` marker is what CSS keys the single-column filter on. The coordinator region is static copy rather than a `conversation.content` reuse: that seat renders a Session-bound conversation, and the coordinator's own Session arrives with its milestone. Open question: replacing activation-time reloads with a registry change stream, which waits on the Host namespace growing one.

</details>

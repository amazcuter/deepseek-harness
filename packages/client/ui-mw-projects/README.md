---
description: "MetaWorkFlow project surfaces: the dashboard main panel and sidebar entry that list the Host's registered workflow projects, and the project workbench a project opens onto with its stored definition, node inspector, tool switches, run controls, and pending decisions."
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

English | [中文](README.zh.md)

## Summary

The MetaWorkFlow profile opens on a project dashboard rather than a Session. It lists the registered projects, one row each with its directory, live state, session count, and definition revision, and creates, opens, renames, and removes them through the `projects` Remote namespace. Opening a project switches to its workbench: the stored definition as a flowchart, run controls and run history, the inspector with each node's tool switches and execution record, decisions the coordinator owes, and the coordinator Session rendered in place as the shared Conversation. The package also publishes the startup policy keeping the first screen on the dashboard.

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

**New project** registers a project whose title is the localized “Untitled project”; the Host decides its directory under the Harness home. The row appears as soon as the Host echo arrives, then **Rename** gives it a real name.

**Use the novel template** registers a project titled “Novel draft”, stores the built-in novel workflow as its first definition through `projects.importDefinition`, and opens it. The template is a JSON document under `src/client/templates/`: `prepare` (Python) → `draft` (Agent) → parallel `review-style` and `review-consistency` (Agent) → `gate` (Python, waiting for both reviews) → `publish` (Python), with `gate` looping back to `draft` at most three times when either review rejects. The two reviews carry different tool selections — `read` for style, `read` and `grep` for consistency — while the draft keeps `read` and `write`, so the template demonstrates per-node tool lists that survive reopening the project. The Host validates the document before it stores the revision, so a template that stops validating is refused instead of stored, and `tests/novel-template.host.spec.ts` runs that same validator over the shipped file.

**Import Mermaid** opens a dialog with a project name and a flowchart source. Submitting calls `projects.importMermaid`, which registers the project, parses the flowchart, translates it into a definition, and stores that definition as the project's first revision — a refused flowchart registers nothing. On success the dialog hides itself, the list reloads, and the composition opens the new project's workbench. A refusal is structured rather than a sentence: the dialog shows the source line when the parser named one, the refusal code, the validator messages of a graph that translated but cannot run, and a **Retry** that resubmits the same draft, so one typo costs neither the text nor the project name.

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

- **Workflow canvas** — the stored definition drawn as a Mermaid flowchart: one node per definition node, one arrow per edge, and the condition text on every conditioned arrow. Clicking a node — or pressing Enter or Space on it — selects it for the inspector; the selected node is drawn with a heavier brand stroke, and every node is colored by the status of its newest activation (`succeeded`, `running`, `failed`, `waiting`, `pending`). Mermaid is loaded lazily, so a dashboard that never opens a project pays nothing for it, and the diagram renders under `securityLevel: 'strict'` with HTML labels off. **Zoom in**, **Zoom out**, and **Reset zoom** scale the drawing inside its own scrolling box. A render Mermaid refuses leaves the reason and the exact generated source on screen with a **Retry**, because that source is the only way to tell an unsupported definition from a Mermaid fault. **Run** starts a run from the newest revision (the Host validates the stored document, creates the run, and advances it once), **Pause** stops further activations, and **Resume** restarts a paused run. All three are disabled without an executable definition, and the note under them says why; a stored document that no longer validates lists its violations instead of a diagram.
- **Run history** — every run the project recorded, newest first, with its status, the definition revision it executes, when it started, when it ended, and the reason the scheduler recorded. The list is read through `projects.runs` and re-read on the same timer as the run itself, so a run that settles while the panel is open appears without a reload.
- **Node details** — the inspector for the node selected in the canvas, across three tabs. **Configuration** shows a writable title beside the read-only kind, Python source or agent instructions, memory policy, output schema, and join. **Tool switches** lists one switch per tool the Host registers plus any name the node still declares. Only a registered tool is writable: a declared name the deployment does not register is listed with the reason and cannot be switched, so the inspector never writes a definition this composition cannot execute. **Inputs and results** shows the node's input bindings, its output schema, and every attempt of the newest run with the failure each recorded. A Python node has no tool switches, and its own copy says so.
- **Project coordinator** — the decisions the project waits on: the node that asked, its question, the choices it proposed, and a quick-reply field that answers through `projects.answerDecision`. **Refresh** re-reads them. Below them the coordinator Session is rendered in place as the shared Conversation: the panel retains the Session, binds it through the renderer's `SessionProvider`, and renders the `conversation.content` Factory with the chat view selected. **Open the coordinator Session in a new tab** stays available beside it for the full conversation view.

A wide frame puts the canvas and the inspector in the middle column with the coordinator beside them. A narrow frame collapses to one column and shows a **Canvas** / **Details** / **Conversation** switch, so the three columns never squeeze into each other.

### Startup policy

The plugin publishes `sessionRestorePolicy` with `restoreLastSession: false`. [ui-workspace](../ui-workspace/README.md) owns that optional policy contract: with the policy absent, startup reopens the previously selected Session; with it set to `false`, startup leaves the first screen to the dashboard the composition selected. The dashboard selects its own main panel once per activation, so the profile lands on the project home rather than on a conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers two keyed `main` panels — `projects` and `project` — from one `ctx.slots.inject` generator, so both appear and disappear with the same declaration, plus one `sidebar.panellist` entry that carries the `projects` id so the sidebar can return to the dashboard after a Session is opened. The generator shares one open callback between the panels: only the dashboard row and the workbench switcher call it, and the workbench is selected after the Host confirms the open. A call that settles after the contribution collapsed is dropped rather than selecting a panel that no longer exists.

`ProjectsController` is the React-free object layer over `ctx.remote.projects`. It owns one `ProjectsSnapshot` — the list state (`loading`, `ready`, or `error` with its failure), the rows, the selected project, the last mutation failure, the flowchart-import state, and the in-flight flag — and publishes it as a bare observable. Every mutation updates the snapshot from the Host's echo, never from an optimistic local draft; a call that rejects is folded into the same failure codes instead of escaping as an unhandled rejection. `open()` additionally reports whether the Host opened the project, which is what lets the composition navigate only on success. `importMermaid()` keeps the structured refusal the plain failure fold would drop — the parser's source line, its refusal code, and the validator messages — because the dialog renders each part separately. The plugin starts the first load with the composition and hands the observable to both panels through the inject `hooks` compartment, so each component reads `useProjects` and calls its own injected callbacks.

`WorkbenchController` is the second React-free object layer, over the same namespace. It owns one `WorkbenchSnapshot` — the coordinator Session identity, the definition document with its violations, the selected node, that node's tool switches, the pending decisions, the newest run with its activations, that run's attempts, and the project's run history — and publishes it as a bare observable. `open()` replaces the whole snapshot and reads the five verbs in parallel, and a generation counter drops a slower earlier read so a project switch cannot publish stale nodes into the project now on screen. Every edit and every run control goes through `mutate()`, which publishes the in-flight flag, folds the failure into the snapshot, and then re-reads the definition and the node it kept selected. A failed history read keeps the rows already published, so a transient carrier fault never blanks the list.

The canvas is a separate reading of the stored document. `definition-graph.ts` parses the canonical JSON text the Host projected and validates every member it touches, because that text crossed the Remote and only the projected node views are typed; `mermaid-graph.ts` turns the graph into `flowchart TD` source and keeps a map from the id it emitted to the definition node it drew, since a definition id may carry `-` and Mermaid would read it as syntax; `mermaid-render.ts` loads Mermaid through a dynamic `import()` that the client bundle emits as its own chunk and reports a refusal instead of throwing. `WorkflowCanvas.tsx` inserts the returned SVG, decorates each drawn `g.node` group with the node it represents, the status that colors it, and the inspector selection, and delegates every click and key from its stable container, because React must never diff Mermaid's own subtree. The tint table in `node-paint.ts` paints inline declarations over Mermaid's own theme sheet and references `--dsw-*` tokens, so the diagram follows the active theme.

The components keep local state only: which row is being renamed or confirmed and whether the import dialog is open on the dashboard, and the narrow-frame section, the node tab, the title draft, the decision reply drafts, the project menu, the canvas zoom, and the retained coordinator reference on the workbench. Copy lives in the `mw.projects` dictionary registered with `client-locale`, with Chinese as the authored side; the failure-code-to-copy table is shared by both panels in `failures.ts`. The locale files under `locale/` carry only plugin display metadata.

The coordinator column is the one place where this package renders another plugin's content. The `project` panel declares the session-scoped child slot `mw.projects.coordinator`, which is what makes the renderer hand it a `SessionProvider`; the entry registered on that slot renders the shared `conversation.content` Factory with the chat view selected. The panel retains the coordinator Session from the apply world — a reference is the only thing the renderer can bind a scope from — and releases it when the Session changes or the panel leaves, so the embedded Conversation reads that Session's own sources without this package owning any conversation state.

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

No model-visible input. The `project` main panel renders the selected project's stored definition as a flowchart, its tool switches, decisions, run state, and run history, and it renders the coordinator Session's Conversation — which reaches the model only through that Session's own turns, exactly as the shared conversation view does. Nothing this panel adds reaches a request.

#### Token effect

Zero direct effect on model requests.

#### KV Cache effect

No effect: no prompt text, tool schema, or request context is added, replaced, or reordered.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No live list stream** — the dashboard reloads on activation and patches rows from mutation echoes; another window's registration appears only after a reload.
- **Mermaid is bundled, not shared** — the flowchart renderer is a private async chunk of this package (about a megabyte over the wire), so a second surface that drew definitions would carry its own copy. A shared renderer belongs in a static library beside `ui-primitives`. It is one chunk rather than Mermaid's own split: the Client module loader materializes only the chunk a factory requests, so Mermaid's cross-chunk requires have no table entry.
- **The canvas redraws on every definition revision** — a title edit re-renders the whole diagram and Mermaid lays it out again. Diffing the source, or caching the layout, is the follow-up.
- **The diagram is not the run's live view** — node colors come from the newest run the workbench polled, so a running activation colors its node only after the next four-second read.
- **A run start waits for the first tick** — `projects.startRun` returns when the scheduler stops dispatching, so a long agent node keeps the request open instead of streaming progress. A run-state subscription is the follow-up.
- **Decisions are polled, not pushed** — the workbench re-reads `projects.pendingDecisions` on a four-second timer, after each action, and on **Refresh**, instead of subscribing to `workflow/decision-requested` and `workflow/decision-answered`. A decision therefore appears up to one interval late.
- **Only the title and the tool list are writable** — instructions, source, schema, inputs, and edges stay read-only in the inspector; the coordinator Session owns those edits.
- **The workbench keeps no per-project view state** — switching projects preserves the section and node tab on screen, and nothing survives a reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Six mechanisms carry this package, so moving one means revisiting the others. The Remote owns the data: rows, mutation echoes, and failures all arrive through `ctx.remote.projects`, and a Host that answers slowly is never a reason to keep a local draft. `ProjectsController` is the only writer of the snapshot — `load()` moves `loading` to `ready` or `error` once, every mutation overlays `busy` and `mutationError` on that list state, and `busy` counts in-flight calls so overlapping mutations keep the controls disabled until the last settles. The ready gate keeps creation and row mutations disabled while `view.status !== 'ready'`, because a failed load has no rows to patch. Both failure forms fold into one `ProjectFailure`, and the shared code-to-copy table needs a key for every code the namespace can raise. Copy lives in the `mw.projects` dictionary with Chinese as the authored side; `locale/*.json` carries display metadata only.

The workbench panel is a consumer of the same snapshot rather than a second controller: it derives the open project from `openedProjectId` and renders the project list's empty state when that id is gone, which is what a removal leaves behind. Its narrow-frame layout is a CSS container query on the panel's own width plus a local section value, so the width decision never depends on the window and the sidebar's presence cannot squeeze the three columns; the `data-active` marker is what CSS keys the single-column filter on. The canvas owns its own DOM: Mermaid's SVG is assigned once per render and then decorated in place, so a change to the drawn node set goes through a new render of the source rather than a React diff of the diagram. The package's `tsdown.config.ts` bundles Mermaid through a nested build into one virtual module and names that chunk through a code-splitting group: Mermaid's own output splits its diagram renderers across chunks that share code synchronously, which the Client module loader cannot serve. The coordinator column retains its Session reference in an effect and renders the child slot inside the provided `SessionProvider`; the same effect releases it, so a project switch cannot leave a Session retained behind the dashboard. Open question: replacing activation-time reloads with a registry change stream, which waits on the Host namespace growing one.

</details>

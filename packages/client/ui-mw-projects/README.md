---
description: "MetaWorkFlow project dashboard: the keyed main panel and sidebar entry that list the Host's registered workflow projects, create, open, rename, and remove one, and start a project from a new or imported Mermaid workflow."
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

English | [中文](README.zh.md)

## Summary

The MetaWorkFlow profile opens on a project dashboard instead of the previous Session. It lists the projects the Host has registered — one row per independent workflow, with its directory, live directory state, session count, and definition revision — and creates, opens, renames, and removes them through the `projects` Remote namespace. The package also publishes the startup policy that keeps the first screen on this dashboard.

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

- **Open** calls `projects.open`, which materializes the project database when the directory exists without one. The row is marked with `aria-current` and the panel shows the placeholder workbench naming the selected project.
- **Rename** swaps the title for an inline editor. Enter or **Save** commits the trimmed title, Escape and **Cancel** discard it, and a blank draft cannot be saved.
- **Delete** first asks in place: the confirmation names the project and repeats that only the registration is removed. The project directory and every Session stay on disk; the panel repeats that below the list.

A mutation in flight disables the row controls and the create action. A failed mutation leaves the list untouched and shows the localized reason with the Host diagnostic above it.

A narrow frame stacks each card — Host facts first, then the actions on their own line — so nothing needs horizontal scrolling.

### Startup policy

The plugin publishes `sessionRestorePolicy` with `restoreLastSession: false`. [ui-workspace](../ui-workspace/README.md) owns that optional policy contract: with the policy absent, startup reopens the previously selected Session; with it set to `false`, startup leaves the first screen to the dashboard the composition selected. The dashboard selects its own main panel once per activation, so the profile lands on the project home rather than on a conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers one keyed `main` panel named `projects` and one `sidebar.panellist` entry that carries the same id, so the sidebar can return to the dashboard after a Session is opened. Both wait on their slot declarations through `ctx.slots.inject`, so apply order against [ui-layout](../ui-layout/README.md) and [ui-sidebar](../ui-sidebar/README.md) is unconstrained.

`ProjectsController` is the React-free object layer over `ctx.remote.projects`. It owns one `ProjectsSnapshot` — the list state (`loading`, `ready`, or `error` with its failure), the rows, the selected project, the last mutation failure, and the in-flight flag — and publishes it as a bare observable. Every mutation updates the snapshot from the Host's echo, never from an optimistic local draft; a call that rejects is folded into the same failure codes instead of escaping as an unhandled rejection. The plugin starts the first load with the composition and hands the observable to the panel through the inject `hooks` compartment, so the component reads `useProjects` and calls the injected callbacks.

The component keeps one piece of local state: which row is being renamed or confirmed. Copy lives in the `mw.projects` dictionary registered with `client-locale`, with Chinese as the authored side; the failure-code-to-copy table lives beside the component. The locale files under `locale/` carry only plugin display metadata.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-layout](../ui-layout/README.md) — the frame that owns the keyed `main` slot.
- [ui-sidebar](../ui-sidebar/README.md) — the panel list this entry joins.
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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No live list stream** — the dashboard reloads on activation and patches rows from mutation echoes; another window's registration appears only after a reload.
- **Import does not parse Mermaid yet** — the action ships disabled; parsing, rendering, and the coordinator flow arrive with the workflow-definition milestone.
- **Opening a project only selects it** — the project workbench (canvas, coordinator conversation, node inspector) is a later milestone, so the panel shows a placeholder naming the selection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Five mechanisms carry this package, so moving one means revisiting the others. The Remote owns the data: rows, mutation echoes, and failures all arrive through `ctx.remote.projects`, and a Host that answers slowly is never a reason to keep a local draft. `ProjectsController` is the only writer of the snapshot — `load()` moves `loading` to `ready` or `error` once, every mutation overlays `busy` and `mutationError` on that list state, and `busy` counts in-flight calls so overlapping mutations keep the controls disabled until the last settles. The ready gate keeps creation and row mutations disabled while `view.status !== 'ready'`, because a failed load has no rows to patch. Both failure forms fold into one `ProjectFailure`, and the component's code-to-copy table needs a key for every code the namespace can raise. Copy lives in the `mw.projects` dictionary with Chinese as the authored side; `locale/*.json` carries display metadata only. Open question: replacing activation-time reloads with a registry change stream, which waits on the Host namespace growing one.

</details>

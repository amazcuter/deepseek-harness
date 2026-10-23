---
description: "MetaWorkFlow project dashboard: the keyed main panel and sidebar entry that list workflow projects, open one, and start a project from a new or imported Mermaid workflow."
kind: "package-reference"
---

# @metaworkflow/client-ui-mw-projects

English | [中文](README.zh.md)

## Summary

The MetaWorkFlow profile opens on a project dashboard instead of the previous Session. It lists one row per independent workflow with its purpose and lifecycle state, and starts a project either empty or from an imported Mermaid flowchart. The package also publishes the startup policy that keeps the first screen on this dashboard. The project list is an in-memory placeholder for the project service that arrives with project storage.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

`mwf metaworkflow` opens the dashboard. The page names the profile's home, explains that each project holds one independent workflow, and either shows the empty state or the project list.

### Empty state

With no projects, the dashboard offers two ways to start: **New project** and **Import Mermaid**. The primary action appends an in-memory draft project named “Untitled project”; the secondary action appends a placeholder project named “Imported workflow”. Both rows appear immediately in the list, and either way the project is a placeholder until the project service persists it.

### Project list

Each row shows the project name, purpose, and current state (`Draft`, `Running`, `Paused`, `Completed`). **Open project** records the row as the opened project and marks it with `aria-current`. Creating another project keeps its row at the end of the list. A narrow frame collapses each row to one column and labels every cell from its localized column name, so the list stays readable without horizontal scrolling.

### Startup policy

The plugin publishes `sessionRestorePolicy` with `restoreLastSession: false`. [ui-workspace](../ui-workspace/README.md) owns that optional policy contract: with the policy absent, startup reopens the previously selected Session; with it set to `false`, startup leaves the first screen to the dashboard the composition selected. The dashboard selects its own main panel once per activation, so the profile lands on the project home rather than on a conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers one keyed `main` panel named `projects` and one `sidebar.panellist` entry that carries the same id, so the sidebar can return to the dashboard after a Session is opened. Both wait on their slot declarations through `ctx.slots.inject`, so apply order against [ui-layout](../ui-layout/README.md) and [ui-sidebar](../ui-sidebar/README.md) is unconstrained.

The panel declares one store, `createProjectsStore()`. It holds the placeholder project list and the opened row; the component reads through `useStore` and writes only through the declared actions. The store is temporary by design: the project service replaces it when project storage lands, while `ProjectSummary` stays the component contract.

Copy lives in the `mw.projects` dictionary registered with `client-locale`, with Chinese as the authored side. The locale files under `locale/` carry only plugin display metadata.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-layout](../ui-layout/README.md) — the frame that owns the keyed `main` slot.
- [ui-sidebar](../ui-sidebar/README.md) — the panel list this entry joins.
- [ui-workspace](../ui-workspace/README.md) — the startup policy consumer and Session navigation.
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

- **The project list is in-memory** — a browser reload starts from the empty state until the project service publishes durable projects.
- **Import does not parse Mermaid yet** — the action appends a placeholder row; parsing, rendering, and the coordinator flow arrive with the workflow-definition milestone.
- **Opening a project only records the selection** — the project workbench (canvas, coordinator conversation, node inspector) is a later milestone.

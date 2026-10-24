---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@metaworkflow/api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` with the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own, and `ctx.mwProjectController` with the generated `ctx.remote.projects` namespace the project dashboard reads for its list, create, open, rename, and delete.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The controller injects `remoteAccess` and registers the `workspace` resource kind with the default field `workspaceId` through `typert.resources`. `workspace/follow` reads no resource, so its call touches the `global` resource: a Peer whose principal is not the owner may follow it only when its principal kind's policy in [`mwf-api-remote-access`](../remote-access/README.md) binds a `global` role listing the action. For that caller, the baseline, `upsert` frames, and `order` ids keep only the Workspaces `ctx.remoteAccess.allows()` admits as `workspace` resources, and only the Session ids it admits as `session` resources, within each Workspace and in the archived and pinned sets, so `workspace` and `session` roles list the same action. The stream tracks the Workspaces it delivered. When one is no longer admitted at its next change or in a new order, the stream sends a `replace` increment carrying the complete filtered state instead of a `remove`, because a removed id is never resurrected on the Client; `replace` is an ordinary increment that the Client applies like an opening baseline, not the start of a new generation, so it neither reports an error nor reconnects; once access returns, the Workspace reappears through an ordinary `upsert`. A `remove` frame reports a deletion and reaches only a caller that received that Workspace. Owner frames are unfiltered.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

<a id="the-projects-namespace"></a>
### The projects namespace

`ctx.mwProjectController` serves the project dashboard through the generated `ctx.remote.projects` namespace. It holds no project data of its own: `ctx.mwfProjectStore` owns project identity, directory, title, and definition revisions, and `ctx.workspaceRegistry` owns the session account and the display order, so one row composes the two and a store failure is mapped onto the Remote error codes instead of leaking.

| Verb | Request | Response |
| --- | --- | --- |
| `projects.list()` | none | `{ items }`, one `ProjectSummary` per registered project in registry display order |
| `projects.create({ title, path? })` | non-blank `title`; optional existing `path` | `{ project }` |
| `projects.open({ id })` | project id | `{ project }`, materializing the project database when the directory exists without one |
| `projects.rename({ id, title })` | project id and non-blank `title` | `{ project }` |
| `projects.delete({ id })` | project id | `{ deleted: true }`; the registration goes, the directory and its Sessions stay |
| `projects.coordinator({ id })` | project id | `{ sessionId }`, the project's coordinator Session, or `null` when the composition serves no `ctx.mwfCoordinator` |
| `projects.definition({ id })` | project id | `{ revision, document, valid, violations, nodes }`, the newest stored definition projected for the inspector; a document that no longer parses is reported, not refused |
| `projects.importDefinition({ id, document })` | project id and JSON document text | `{ revision, nodeCount }`; the document is validated before it is written and stored in canonical form |
| `projects.availableTools({ id, nodeId })` | project and node id | `{ items }`, one `{ name, description, enabled }` switch per tool `ctx.tools` registers plus every name the node still declares; a python node lists none |
| `projects.updateNode({ id, nodeId, patch })` | project, node id, and `{ title?, tools? }` | `{ revision }`, the revision the patched definition was written as; every other field stays read-only |
| `projects.pendingDecisions({ id })` | project id | `{ items }`, the unanswered decision requests, oldest first |
| `projects.answerDecision({ id, requestId, answer })` | project, request id, non-blank answer | `{ answered: true, runStatus }`; the answer is recorded and the waiting activation resumed |
| `projects.attempts({ id, runId? })` | project id and an optional run id | `{ run, items }`, the named run (newest when omitted) with its activations and its attempts; `run` is `null` before the project starts one |
| `projects.startRun({ id })` | project id | `{ runId, status }`; the stored definition is validated, the run created, and one tick run before the call returns |
| `projects.pause({ id, runId })` | project and run id | `{ runId, status }` |
| `projects.resume({ id, runId })` | project and run id | `{ runId, status }` |

The definition verbs read and write through `@metaworkflow/workflow-definition`, and the run verbs delegate to `ctx.mwfScheduler`, which they reach with `ctx.get` so a composition without a scheduler still serves the dashboard; `projects.coordinator` reads `ctx.mwfCoordinator` the same way. A composition that serves neither answers `project/workflow-unavailable` with the missing service in `details.capability`. A `ProjectSummary` carries `id` (the value the `workspace` namespace calls `workspaceId`), `title`, `path`, the live directory `status`, `sessionCount`, and `definitionRevision` — the project store's latest revision, or `0` while the registry lists no record for it.

Failures are stable codes: `project/not-found` for an id no registration carries, `project/invalid-path` with `details.path` when the requested directory cannot be registered, `project/path-in-use` with `details.path` when another registration claims that directory, `gateway/bad-request` for a blank title or a tool list on a python node, and `gateway/internal` for the store's remaining storage faults. The workflow verbs add `project/definition-missing`, `project/definition-invalid` with `details.violations`, `project/node-not-found` with `details.nodeId`, `project/run-unavailable` with `details.runId`, `project/decision-unavailable` with `details.requestId`, and `project/workflow-unavailable` with `details.capability`.

A Remote method name may not collide with a member of its namespace service: `install`, `remove`, `has`, and `empty` already sit on that prototype, and the Gateway refuses a verb that reuses one, so deregistration is `projects.delete` rather than `projects.remove`. The Client controller still exposes `remove()` for that call.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

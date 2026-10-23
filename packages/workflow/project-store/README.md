---
description: "Durable workflow projects for the host: the global registry at <home>/mwf/projects.db and one SQLite database per project holding definitions, runs, activations, attempts, artifacts, decisions, and the session outbox."
kind: "package-reference"
---

# @metaworkflow/workflow-project-store

English | [中文](README.zh.md)

## Summary

`mwf-workflow-project-store` keeps workflow projects durable on the host: one registry database lists every project, and each project directory owns a SQLite database for its definition revisions, runs, activations, attempts, artifacts, decisions, and session outbox. Use it to register a project, point one at an existing directory, store a definition revision, read runs back, or stage and acknowledge session events. Writes are serialized per database, so concurrent callers never race. The store is host-only and pre-wired to nothing: no UI, tool, prompt, or scheduler reads it yet.

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

Mount the plugin in a Host composition and drive it through `ctx.mwfProjectStore`; no other plugin is required.

### When to choose it

Choose it when workflow data must survive a process restart and stay inspectable per project: definitions, run history, and pending session events each belong to one project directory. Do not use it as a general key-value store — `@metaworkflow/storage-sqlite` serves routed domain data, while this package owns one durable layout for workflow projects. The store never schedules work and never renders anything; the runner and the GUI land in later stages.

### Minimal configuration

```yaml
- name: '@metaworkflow/workflow-project-store'
```

| Field | Default | Meaning |
|---|---|---|
| `mwfHome` | `$MWF_HOME`, then `~/.mwf` | Harness home override; the layout lives under its `mwf` directory |

The generated [configuration catalog](../../../docs/config-catalog.md#metaworkflowworkflow-project-store) is the exhaustive source for every accepted field.

### Service API

| Method | Behavior |
|---|---|
| `listProjects()` | Every registered project, newest first |
| `createProject({ title, path? })` | Registers a project and materializes its database; omitted `path` uses `<home>/mwf/projects/<projectId>` |
| `openProject(projectId)` | Resolves one project and materializes its database when the file is missing |
| `removeProject(projectId, { deleteDirectory? })` | Removes the registry row, closes the connection, and returns the directory; files stay unless `deleteDirectory` is `true` |
| `readDefinition(projectId, revision?)` | One definition revision, or the newest one |
| `writeDefinition(projectId, document)` | Appends a revision inside one transaction and returns its number |
| `listRuns(projectId)` | Run rows, newest first, with stored statuses validated |
| `listOutbox(projectId, attemptId)` | Staged events of one attempt in event order |
| `appendOutbox(projectId, attemptId, eventSeq, payload)` | Stages one event; repeating the key returns the stored row |
| `markAcked(projectId, attemptId, eventSeq)` | Acknowledges one event once and reports whether this call did it |

### Layout

Two databases per harness home, both created owner-only (`0o700`/`0o600`) where the filesystem honors POSIX modes:

| Path | Content |
|---|---|
| `<home>/mwf/projects.db` | Registry rows: id, directory, title, timestamps, definition-revision hint |
| `<home>/mwf/projects/<projectId>/project.db` | One project's definitions, runs, activations, attempts, artifacts, decisions, and outbox |

A project registered at an explicit directory puts its `project.db` inside that directory, so code, artifacts, and environments stay with the project.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One connection per database and process.** Each database is held through a slot that shares a pending open between concurrent callers, reuses the live handle afterwards, and stays reusable after a failed open.
- **Writes are queued, not raced.** Every write runs on its database's serial queue (one tail promise), so two callers can never interleave statements on one connection and `busy_timeout` never arbitrates in-process contention.
- **One state change is one transaction.** `writeDefinition`, `appendOutbox`, and `markAcked` each run inside `BEGIN IMMEDIATE … COMMIT`; a throwing body rolls back and leaves no residue.
- **No cross-database transaction.** The registry row and a project database row never commit together: the project database stays authoritative and the registry keeps a definition-revision hint, refreshed after the definition commits.
- **The v1 project layout is complete.** Later stages add behavior, not migrations.
- **Identity and version fail loud.** Each file carries its own `PRAGMA application_id` and layout version; any other combination is refused instead of migrated in place.

### Open sequence

For each database the protocol runs in one fixed order: create the directory as `0o700` and the file as `0o600`, set `PRAGMA busy_timeout`, switch `PRAGMA journal_mode` to WAL (bounded retry while another connection holds the file), enable `PRAGMA foreign_keys`, validate `PRAGMA application_id` and `PRAGMA user_version`, materialize the schema, and stamp fresh media last. A zero version with the store's own identity is an interrupted materialization and is finished on the next open; a zero version that already holds foreign tables, or any other version, is refused.

### Schema

The registry holds `projects` (unique directory) and `schema_meta`. A project database holds `definitions`, `nodes` and `edges` (one row per revision, cascading with it), `runs` (referencing the revision it started from), `activations` (unique per run, node, and iteration), `attempts` (unique per activation and attempt number), `artifacts` (unique per activation, name, and version), `decisions`, `session_outbox` (primary key `(attempt_id, event_seq)`, referencing its attempt), and `schema_meta`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.mwfProjectStore`, project lifecycle, definitions, runs, outbox |
| [`src/open.ts`](src/open.ts) | Fixed open protocol, pragmas, WAL retry, identity and version checks |
| [`src/registry.ts`](src/registry.ts) | Registry layout, version, identity, and row statements |
| [`src/project-database.ts`](src/project-database.ts) | Project layout, version, identity, and row statements |
| [`src/database.ts`](src/database.ts) | One lazily opened connection with its write queue |
| [`src/queue.ts`](src/queue.ts) | Tail-promise serial queue |
| [`src/transaction.ts`](src/transaction.ts) | `BEGIN IMMEDIATE … COMMIT` batch with rollback |
| [`src/types.ts`](src/types.ts) | Records, request values, and branded identifiers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow service, hooks, and event vocabulary that will own the runner.
- [Workflow package map](../README.md) — the group's packages and their positions.
- [SQLite storage backend](../../storage/storage-sqlite/README.md) — the routed domain-data medium, which this package deliberately does not use.

-----

<a id="model-experience"></a>
## Model Experience

None, as the store persists workflow records for host consumers and registers no prompt, tool, schema, or session event.

#### KV Cache effect

None — the store never touches a live request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this stage does not do yet and where a caller must compensate.

- **Nothing consumes the store yet** — no UI, tool, or scheduler reads it; the profile, the GUI wiring, and the run persistence API land in later stages.
- **The registry keeps a hint, not the authority** — `writeDefinition` refreshes `definition_revision` after the definition commits, so a registry failure surfaces to the caller although the revision is durable; `readDefinition` is the authoritative read.
- **Deleting a directory is ordered after the registry write** — `removeProject(…, { deleteDirectory: true })` removes the row first, so a failed directory removal leaves unregistered files behind instead of a project without files.
- **One process per database file** — the single-connection rule and the serial queue are per process; a second process writing the same file relies on SQLite's own locking.
- **Lost writes still fail loud** — writes do not survive a process that never flushes, and no backup or repair path exists for a corrupted medium.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The project database declares `nodes`, `edges`, `activations`, `attempts`, `artifacts`, and `decisions` so the compiler and runner stages write into an existing layout instead of migrating it. Only the definition, run, and outbox operations are wired here. The exported `runTransaction` is what lets the runner commit an attempt's terminal status together with its staged outbox events: one batch, one commit, and a rollback removes both.

</details>

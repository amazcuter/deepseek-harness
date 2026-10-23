/**
 * Storage declarations of the workspace registry: the session-group domain it
 * owns and the frozen v2 declaration the one-time migration reads.
 *
 * Project identity — id, directory, title — belongs to
 * `@metaworkflow/workflow-project-store`; this domain holds only what the
 * registry adds on top: the ordered session account of one project, the
 * display order, the first-use marker, and the registry-global archive and pin
 * sets. The zod schemas validate the shipped format at the durability boundary.
 * @module @metaworkflow/workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@metaworkflow/brand'
import type { SessionId } from '@metaworkflow/session'
import type { ProjectId } from '@metaworkflow/workflow-project-store'
import { defineDomain, domainTable } from '@metaworkflow/storage-domain'

/** Project id schema at the durable boundary; branding has no runtime representation. */
const projectId = z.string().transform(value => brandString<ProjectId>(value))

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/**
 * Durable shape of one project's session account: `sessionIds` is the ordered
 * ownership account (array order is display order), `updatedAt` is the epoch
 * millisecond instant of the last account mutation.
 */
export const workspaceGroupRecord = z.object({
  sessionIds: z.array(sessionId),
  updatedAt: z.number(),
})

/** One stored session-group record, inferred from {@link workspaceGroupRecord}. */
export type WorkspaceGroupRecord = z.infer<typeof workspaceGroupRecord>

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the one-time grouping bootstrap;
 * `migratedFromV2` records that the legacy v2 registry was imported, so the
 * import never runs twice. `projectIds` is the authoritative display order and
 * may name only registered projects. `defaultProjectId` keeps the first-use
 * identity after its registration is deleted. `archivedSessionIds` is the
 * registry-global archive set layered over project accounting: an archived
 * session keeps its `sessionIds` slot (unarchiving must restore the position),
 * so the set never participates in the one-owner accounting invariant.
 * `pinnedSessionIds` is the registry-global pin set in pin order (most recently
 * pinned first); pinning and archival are mutually exclusive, so archiving
 * drops the session's pin.
 */
export const workspaceProjectState = z.object({
  initialized: z.boolean(),
  /** The legacy v2 registry was imported; the import never repeats. */
  migratedFromV2: z.boolean(),
  /** First-use project identity, retained after its registration is deleted. */
  defaultProjectId: projectId.optional(),
  projectIds: z.array(projectId),
  archivedSessionIds: z.array(sessionId),
  pinnedSessionIds: z.array(sessionId),
})

/** Durable registry state inferred from {@link workspaceProjectState}. */
export type WorkspaceProjectState = z.infer<typeof workspaceProjectState>

/**
 * The registry's own domain: one `projects` table keyed by {@link ProjectId}
 * holding each project's session account, plus the registry singleton. The
 * registry opens this through `ctx.storage.domain`; the spec object is the
 * single source of the domain's identity, version, and schemas.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace_projects',
  version: 1,
  global: {
    schema: workspaceProjectState,
    initial: {
      initialized: false,
      migratedFromV2: false,
      projectIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
  },
  tables: { projects: domainTable<ProjectId, WorkspaceGroupRecord>(workspaceGroupRecord) },
})

/**
 * Frozen declaration of the shipped v2 `workspace` domain, kept only so the
 * migration can read a profile written before project identity moved to the
 * project store. Its medium is never rewritten: the registry opens it, reads
 * every record, closes it, and leaves the file as it found it.
 */
export const legacyWorkspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored v2 workspace record, inferred from {@link legacyWorkspaceRecord}. */
export type LegacyWorkspaceRecord = z.infer<typeof legacyWorkspaceRecord>

/** v2 pending-mutation marker; carried so an unreadable v2 global never blocks the import. */
const legacyPendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId: projectId }),
  z.object({ operation: z.literal('delete'), workspaceId: projectId }),
])

/** Durable v2 registry state, read only to carry the default identity and the global session sets. */
export const legacyWorkspaceState = z.object({
  initialized: z.boolean(),
  defaultWorkspaceId: projectId.optional(),
  workspaceIds: z.array(projectId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  pendingMutation: legacyPendingMutation.optional(),
})

/** Durable v2 registry state, inferred from {@link legacyWorkspaceState}. */
export type LegacyWorkspaceState = z.infer<typeof legacyWorkspaceState>

/** The v2 domain declaration the migration opens read-only. */
export const legacyWorkspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: legacyWorkspaceState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
  },
  tables: { workspaces: domainTable<ProjectId, LegacyWorkspaceRecord>(legacyWorkspaceRecord) },
})

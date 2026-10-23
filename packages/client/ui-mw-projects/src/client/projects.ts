/**
 * Project dashboard data and its declared store. The project list is the
 * placeholder shape the project service will publish: one row per independent
 * workflow. Until that service exists, the dashboard's in-memory store is the
 * only writer, so a browser reload starts from an empty list.
 */
import type { Branded } from '@metaworkflow/brand'
import { brandString } from '@metaworkflow/brand'
import { defineStore, type EngineStoreHandle } from '@metaworkflow/client-store'

/** Opaque identity of one workflow project. */
export type ProjectId = Branded<'ProjectId'>

/** Workflow lifecycle state shown in the dashboard's status column. */
export type ProjectStatus = 'draft' | 'active' | 'paused' | 'done'

/** One workflow project row: the complete dashboard data contract. */
export interface ProjectSummary {
  /** Stable project identity, independent of its display name. */
  readonly id: ProjectId
  /** Human-readable project name. */
  readonly name: string
  /** What the workflow does, in the user's words. */
  readonly purpose: string
  /** Lifecycle state the status column renders. */
  readonly status: ProjectStatus
}

/** Dashboard state: the project list plus the row the user last opened. */
export interface ProjectsState {
  /** Every project the dashboard lists, in creation order. */
  projects: ProjectSummary[]
  /** The row whose Open action ran, or null before any open. */
  openedProjectId: ProjectId | null
}

/** Write set of the dashboard store. */
type ProjectsActions = {
  /** Append one project; later Host refreshes replace this in-memory list. */
  addProject: (draft: ProjectsState, project: ProjectSummary) => void
  /** Record the row whose Open action ran. */
  openProject: (draft: ProjectsState, id: ProjectId) => void
}

/**
 * Mint one placeholder project id.
 * @param sequence - invocation-local counter, so ids stay unique per dashboard session.
 * @returns the branded project identity.
 */
export function projectId(sequence: number): ProjectId {
  return brandString<ProjectId>(`project-${String(sequence)}`)
}

/**
 * Create the dashboard store handle. Seed data is a test and preview input;
 * production starts empty until the project service publishes its list.
 * @param seed - initial project rows, empty for the shipped dashboard.
 * @returns the store handle consumed by the registration and by store tests.
 */
export function createProjectsStore(seed: readonly ProjectSummary[] = []): EngineStoreHandle<ProjectsState, ProjectsActions> {
  return defineStore({
    init: (): ProjectsState => ({ projects: [...seed], openedProjectId: null }),
    actions: {
      addProject: (draft, project) => {
        draft.projects.push(project)
      },
      openProject: (draft, id) => {
        draft.openedProjectId = id
      },
    },
  })
}

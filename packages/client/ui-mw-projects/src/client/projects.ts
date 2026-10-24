/**
 * Project dashboard data: the Host's registered-project rows and the
 * React-free controller that turns `projects.*` Remote calls into one
 * observable dashboard snapshot.
 *
 * The dashboard keeps no project data of its own. Every row, mutation echo,
 * and failure comes from the Host namespace, so the panel shows what the
 * registry holds rather than an optimistic local draft.
 */

import { createSnapshotStore, type SnapshotStore } from '@metaworkflow/client-store'
import type { HostObservable } from '@metaworkflow/client-ui-slots'
import type { ClientRemote, RemoteErrorCode, RemoteResult } from '@metaworkflow/api-remotes/client'
import { settleRemote } from './remote-outcome.ts'
import type { ProjectSummary, WorkspaceId } from '@metaworkflow/api-workspace-controller/types'

/** Opaque identity of one registered project: the Host id of its Workspace. */
export type ProjectId = WorkspaceId

/** Live state of a project's directory, as the Host reports it. */
export type ProjectStatus = ProjectSummary['status']

/** One dashboard row: the Host's registered-project projection, unchanged. */
export type { ProjectSummary }

/** Complete generated `ctx.remote.projects` namespace. */
export type ProjectsRemote = ClientRemote['projects']

/** Which list state the panel renders. */
export type ProjectsView =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly failure: ProjectFailure }

/** Immutable dashboard state. */
export interface ProjectsSnapshot {
  /** The list state the panel renders, with the failure when it has one. */
  readonly view: ProjectsView
  /** Every registered project in Host display order. */
  readonly projects: readonly ProjectSummary[]
  /** The row whose Open action succeeded, or null before any open. */
  readonly openedProjectId: ProjectId | null
  /** Failure of the most recent mutation, cleared when the next one starts. */
  readonly mutationError: ProjectFailure | null
  /** A mutation is in flight, so its controls stay disabled. */
  readonly busy: boolean
}

/** One failed Remote call, reduced to what the dashboard renders. */
export interface ProjectFailure {
  /** Stable failure code; the component maps it onto localized copy. */
  readonly code: RemoteErrorCode
  /** Host diagnostic, shown verbatim below the localized message. */
  readonly message: string
}


/**
 * Read and mutate the Host project registry for the dashboard.
 *
 * Every method settles after publishing its own result and never rejects: a
 * carrier or assembly failure becomes the view's failure or the
 * `mutationError`, which the panel renders with a retry.
 */
export class ProjectsController {
  private readonly store: SnapshotStore<ProjectsSnapshot>
  private inFlight = 0
  /**
   * Dashboard snapshot source, bound as the panel's `useProjects` hook.
   */
  readonly list: HostObservable<ProjectsSnapshot>

  /** @param remote - generated `ctx.remote.projects` namespace. */
  constructor(private readonly remote: ProjectsRemote) {
    this.store = createSnapshotStore<ProjectsSnapshot>({
      view: { status: 'loading' },
      projects: [],
      openedProjectId: null,
      mutationError: null,
      busy: false,
    })
    this.list = {
      getSnapshot: () => this.store.getSnapshot(),
      subscribe: listener => this.store.subscribe(listener),
    }
  }

  /**
   * Replace the dashboard list with the Host registry.
   * @returns a promise settled once the list or its failure is published.
   */
  async load(): Promise<void> {
    this.patch({ view: { status: 'loading' } })
    const outcome = await settleRemote(() => this.remote.list())
    this.patch(outcome.ok
      ? { view: { status: 'ready' }, projects: [...outcome.value.items] }
      : { view: { status: 'error', failure: outcome.failure } })
  }

  /**
   * Register a project and place its row, appending when the registry is new to it.
   * @param title - project title; the Host rejects a blank one.
   * @returns a promise settled once the row or the failure is published.
   */
  async create(title: string): Promise<void> {
    await this.mutate(() => this.remote.create({ title }), (value) => {
      this.patch({ projects: upsertProject(this.current().projects, value.project) })
    })
  }

  /**
   * Open one project on the Host and mark its row selected.
   * @param id - project to open.
   * @returns whether the Host opened it: false once the failure is published as
   * the `mutationError`, which leaves the previous selection in place.
   */
  async open(id: ProjectId): Promise<boolean> {
    return await this.mutate(() => this.remote.open({ id }), (value) => {
      this.patch({
        projects: upsertProject(this.current().projects, value.project),
        openedProjectId: value.project.id,
      })
    })
  }

  /**
   * Rename one project and patch its row with the Host's echo.
   * @param id - project to rename.
   * @param title - proposed title; the Host rejects a blank one.
   * @returns a promise settled once the row or the failure is published.
   */
  async rename(id: ProjectId, title: string): Promise<void> {
    await this.mutate(() => this.remote.rename({ id, title }), (value) => {
      this.patch({ projects: upsertProject(this.current().projects, value.project) })
    })
  }

  /**
   * Remove one project registration. The directory and its Sessions stay.
   * @param id - project to deregister.
   * @returns a promise settled once the row is gone or the failure is published.
   */
  async remove(id: ProjectId): Promise<void> {
    // `projects/delete` is the Host verb: a Remote method named `remove` would
    // collide with the Gateway namespace service's own member of that name.
    await this.mutate(() => this.remote.delete({ id }), () => {
      const { projects, openedProjectId } = this.current()
      this.patch({
        projects: projects.filter(project => project.id !== id),
        openedProjectId: openedProjectId === id ? null : openedProjectId,
      })
    })
  }

  /** @returns the published snapshot. */
  private current(): ProjectsSnapshot {
    return this.store.getSnapshot()
  }

  /** Publish one changed slice over the current snapshot. */
  private patch(next: Partial<ProjectsSnapshot>): void {
    this.store.set({ ...this.current(), ...next })
  }

  /**
   * Run one mutation, publishing its in-flight state and its echo.
   * @returns whether the Host call succeeded.
   */
  private async mutate<Value>(
    call: () => Promise<RemoteResult<Value>>,
    accept: (value: Value) => void,
  ): Promise<boolean> {
    this.inFlight += 1
    this.patch({ busy: true, mutationError: null })
    const outcome = await settleRemote(call)
    this.inFlight -= 1
    this.patch({ busy: this.inFlight > 0 })
    if (!outcome.ok) {
      this.patch({ mutationError: outcome.failure })
      return false
    }
    accept(outcome.value)
    return true
  }
}

/**
 * Replace the row with `project`'s id, or append it when the list has none.
 * @param projects - current rows.
 * @param project - Host echo to place.
 * @returns the updated rows.
 */
function upsertProject(
  projects: readonly ProjectSummary[],
  project: ProjectSummary,
): ProjectSummary[] {
  return projects.some(row => row.id === project.id)
    ? projects.map(row => (row.id === project.id ? project : row))
    : [...projects, project]
}

/**
 * Reduce one Remote failure branch to what a panel renders.
 * @param failure - the Remote envelope's failure branch.
 * @returns the panel's copy-facing failure.
 */
export function failureOf(failure: { readonly code: RemoteErrorCode; readonly message: string }): ProjectFailure {
  return { code: failure.code, message: failure.message }
}

/**
 * Read the message of one rejected assembly or carrier call.
 * @param error - a rejected assembly or carrier call.
 * @returns its message, or the stringified value for a non-`Error` rejection.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

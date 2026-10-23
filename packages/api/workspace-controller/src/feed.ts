/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@metaworkflow/deque'
import type { DomainChanged } from '@metaworkflow/storage-domain'
import type { Workspace, WorkspaceChanged } from '@metaworkflow/workspace'
import { workspaceProjectState, WorkspaceId } from '@metaworkflow/workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

/** The frames the feed produces: every follow frame except `replace`, which only access filtering sends. */
type WorkspaceFeedFrame = Exclude<WorkspaceFollowFrame, { readonly type: 'replace' }>

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private knownIds: Set<string>
  private order: readonly string[]
  private archived: readonly string[]
  private pinned: readonly string[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.knownIds = new Set(baseline.map(workspace => String(workspace.id)))
    this.order = baseline.map(workspace => String(workspace.id))
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.on('workspace/changed', (change: WorkspaceChanged) => { this.projectChanged(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all registered Workspaces plus archived and pinned Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspaceView),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    signal.throwIfAborted()
    const follower = new WorkspaceFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /** Publish a fresh projection of one renamed or re-registered project. */
  private projectChanged(change: WorkspaceChanged): void {
    const id = String(change.workspaceId)
    if (!this.knownIds.has(id)) return
    const workspace = this.ctx.workspaceRegistry.get(change.workspaceId)
    /* v8 ignore next -- a change names a project the registry still holds. */
    if (workspace === undefined) return
    this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace_projects') return
    // The registry global carries the display order and the two Session sets;
    // it is written after a project's account, so one pass publishes both.
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceProjectState.parse(change.value)
      // The registry publishes a project entity before it writes the durable
      // order, and updates its own snapshot after the write, so the committed
      // value is the source of the order while each view comes from the entity.
      const visible: Workspace[] = []
      for (const id of state.projectIds) {
        const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(id))
        if (workspace !== undefined) visible.push(workspace)
      }
      const nextOrder = visible.map(workspace => String(workspace.id))
      const orderChanged = !sameStrings(this.order, nextOrder)
      for (const workspace of visible) {
        const id = String(workspace.id)
        if (this.knownIds.has(id)) continue
        this.knownIds.add(id)
        this.publish({ type: 'upsert', workspace: workspaceView(workspace) })
      }
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: nextOrder.map(WorkspaceId) })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'projects') return
    /* v8 ignore next -- an account write for a known project also emits `workspace/changed`, which carries the fresh view. */
    if (change.operation !== 'deleted') return
    if (!this.knownIds.delete(change.key)) return
    this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
  }

  private publish(frame: Exclude<WorkspaceFeedFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFeedFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFeedFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}

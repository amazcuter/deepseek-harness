/**
 * Join arithmetic: pure set operations over one node's activated incoming edges
 * and their completions, plus the "already fired" state transition that keeps a
 * `first-success` node from firing twice. Failure handling belongs to the
 * scheduler; this module only reports what a successful completion implies.
 *
 * @module @metaworkflow/workflow-definition/join
 */

import type { JoinOutcome, JoinState, WorkflowJoinPolicy } from './types.ts'

/** Join progress for an activation that has not fired yet. */
export const JOIN_NOT_FIRED: JoinState = Object.freeze({ fired: false })

/** Join progress for an activation that already fired. */
const JOIN_FIRED: JoinState = Object.freeze({ fired: true })

/**
 * Evaluate one join step.
 *
 * `all` fires once every activated incoming edge has completed; incoming edges
 * that were never activated are not expected. `first-success` fires on the first
 * completed activated edge and then consumes later completions without firing
 * again. Both policies fire at most once per activation and treat an empty
 * activated set as nothing to join.
 *
 * @param joinPolicy - the node's join policy.
 * @param activatedIncoming - incoming node ids this activation includes, in declaration order.
 * @param completed - incoming node ids that completed successfully.
 * @param state - progress from the previous step of this activation; defaults to not fired.
 * @returns whether to fire now, the completions consumed, the still-pending ids, and the next progress.
 */
export function computeJoin(
  joinPolicy: WorkflowJoinPolicy,
  activatedIncoming: readonly string[],
  completed: readonly string[],
  state: JoinState = JOIN_NOT_FIRED,
): JoinOutcome {
  const activated: string[] = []
  for (const id of activatedIncoming) {
    if (!activated.includes(id)) activated.push(id)
  }
  const completedIds = new Set(completed)
  const done = activated.filter(id => completedIds.has(id))
  if (joinPolicy === 'all') {
    const pending = activated.filter(id => !completedIds.has(id))
    const fire = !state.fired && activated.length > 0 && pending.length === 0
    return { fire, consumed: fire ? activated : [], pending, state: fire ? JOIN_FIRED : state }
  }
  const fire = !state.fired && done.length > 0
  return { fire, consumed: done, pending: [], state: fire ? JOIN_FIRED : state }
}

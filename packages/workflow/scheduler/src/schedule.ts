/**
 * Pure scheduling arithmetic: which activations a run may start now, which
 * iteration a routed edge enters, when a loop is exhausted, and when a run has
 * nothing left to do.
 *
 * Nothing here reads or writes storage; the service loads the rows, asks these
 * functions what they imply, and commits the answer.
 *
 * @module @metaworkflow/workflow-scheduler/schedule
 */

import { computeJoin } from '@metaworkflow/workflow-definition'
import type {
  RoutingFailure,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@metaworkflow/workflow-definition'
import type { RunStatus } from '@metaworkflow/workflow-project-store'
import type { ActivationRow } from './records.ts'
import type { ActivationStatus } from './types.ts'

/** Statuses after which an activation never runs again. */
const TERMINAL: ReadonlySet<ActivationStatus> = new Set<ActivationStatus>(['succeeded', 'failed', 'canceled'])

/**
 * Whether one activation has reached a status it never leaves.
 * @param status - activation status to test.
 * @returns `true` for `succeeded`, `failed`, and `canceled`.
 */
export function isTerminal(status: ActivationStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * The key one (node, iteration) pair is tracked under while a join is evaluated.
 * @param nodeId - node id.
 * @param iteration - loop iteration.
 * @returns a key that distinguishes the same node in different iterations.
 */
function pairKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${String(iteration)}`
}

/**
 * Build the index of nodes by id for one definition.
 * @param definition - the run's definition.
 * @returns the node lookup.
 */
export function nodeIndex(definition: WorkflowDefinition): Map<string, WorkflowNode> {
  return new Map(definition.nodes.map(node => [node.id, node]))
}

/**
 * Require one node of the run's definition.
 * @param nodes - node lookup built by {@link nodeIndex}.
 * @param nodeId - id the activation executes.
 * @returns the node.
 * @throws {Error} when the definition does not declare the node, which a run
 * pinned to one validated revision can never reach.
 */
export function requireNode(nodes: ReadonlyMap<string, WorkflowNode>, nodeId: string): WorkflowNode {
  const node = nodes.get(nodeId)
  if (node === undefined) throw new Error(`workflow run holds an activation of undeclared node "${nodeId}"`)
  return node
}

/**
 * The node a run starts from: the one no edge targets.
 * @param definition - the run's definition.
 * @returns the entry node, which validation guarantees exists.
 */
export function entryNode(definition: WorkflowDefinition): WorkflowNode {
  const targets = new Set(definition.edges.map(edge => edge.to))
  const entry = definition.nodes.find(node => !targets.has(node.id))
  if (entry === undefined) throw new Error('a validated workflow definition always declares one entry node')
  return entry
}

/** The two (node, iteration) sets one readiness decision reads. */
export interface ActivationIndex {
  /** Keys of activations that already succeeded. */
  readonly completed: ReadonlySet<string>
  /** Keys of activations that may still succeed and activate a target. */
  readonly open: ReadonlySet<string>
}

/**
 * Index one run's activations for readiness decisions.
 * @param activations - every activation of the run.
 * @returns the succeeded and still-open (node, iteration) keys.
 */
export function activationIndex(activations: readonly ActivationRow[]): ActivationIndex {
  const completed = new Set<string>()
  const open = new Set<string>()
  for (const activation of activations) {
    if (activation.status === 'succeeded') completed.add(pairKey(activation.nodeId, activation.iteration))
    if (!isTerminal(activation.status)) open.add(pairKey(activation.nodeId, activation.iteration))
  }
  return { completed, open }
}

/**
 * Whether some declared predecessor may still activate this node in this round.
 *
 * An `all` join must not fire on the branches that happened to finish first: a
 * predecessor whose activation may still route an edge into this iteration is
 * awaited even though its edge has not been activated yet. A branch the routing
 * never selects leaves no activation, so it is never awaited.
 * @param definition - the run's definition.
 * @param node - the node the activation executes.
 * @param iteration - the activation's iteration.
 * @param index - the run's activation index.
 * @returns `true` when a declared predecessor is still open for this round.
 */
function predecessorOpen(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  iteration: number,
  index: ActivationIndex,
): boolean {
  for (const edge of definition.edges) {
    if (edge.to !== node.id) continue
    const sourceIteration = edge.loop === undefined ? iteration : iteration - 1
    if (sourceIteration < 0) continue
    if (index.open.has(pairKey(edge.from, sourceIteration))) return true
  }
  return false
}

/**
 * Whether one activation's join is satisfied by the results already committed.
 *
 * An activation with no incoming activation is the run's entry and is ready at
 * once. Every other activation reads the incoming set frozen when routing
 * created it, so an older iteration's result never satisfies a newer round. An
 * `all` join additionally waits while a declared predecessor of this round is
 * still open; a `first-success` join fires on the first committed success.
 * @param definition - the run's definition.
 * @param node - the node the activation executes.
 * @param activation - the activation to test; a non-pending activation is never ready.
 * @param index - the run's activation index.
 * @returns whether the scheduler may start this activation now.
 */
export function activationReady(
  definition: WorkflowDefinition,
  node: WorkflowNode,
  activation: ActivationRow,
  index: ActivationIndex,
): boolean {
  if (activation.status !== 'pending') return false
  if (activation.incoming.length === 0) return true
  const activated = activation.incoming.map(incoming => pairKey(incoming.nodeId, incoming.iteration))
  const done = activated.filter(key => index.completed.has(key))
  if (!computeJoin(node.join, activated, done).fire) return false
  return node.join !== 'all' || !predecessorOpen(definition, node, activation.iteration, index)
}

/**
 * Every activation the run may start now, in creation order.
 * @param definition - the run's definition.
 * @param activations - every activation of the run.
 * @returns the ready activations.
 * @throws {Error} when an activation names a node the definition does not declare.
 */
export function readyActivations(
  definition: WorkflowDefinition,
  activations: readonly ActivationRow[],
): ActivationRow[] {
  const nodes = nodeIndex(definition)
  const index = activationIndex(activations)
  const ready: ActivationRow[] = []
  for (const activation of activations) {
    if (activationReady(definition, requireNode(nodes, activation.nodeId), activation, index)) ready.push(activation)
  }
  return ready
}

/**
 * The iteration an edge's target activation belongs to.
 * @param sourceIteration - iteration of the activation the edge leaves.
 * @param edge - the routed edge.
 * @returns the source iteration, plus one for a loop edge.
 */
export function targetIteration(sourceIteration: number, edge: WorkflowEdge): number {
  return edge.loop === undefined ? sourceIteration : sourceIteration + 1
}

/**
 * Index the definition's edges by id, for routing results that name edges.
 * @param definition - the run's definition.
 * @returns the edge lookup.
 */
export function edgeIndex(definition: WorkflowDefinition): Map<string, WorkflowEdge> {
  return new Map(definition.edges.map(edge => [edge.id, edge]))
}

/**
 * A human-readable reason for one routing failure, stored as the run's reason.
 * @param failure - the failure `route` reported.
 * @returns the code followed by its actionable description.
 */
export function routingFailureReason(failure: RoutingFailure): string {
  const candidates = failure.candidates.length === 0 ? '' : ` (${failure.candidates.join(', ')})`
  return `${failure.code}: ${failure.message}${candidates}`
}

/**
 * The status a run settles on once every activation is terminal.
 *
 * A canceled activation only settles the run as canceled when nothing failed;
 * any failed activation fails the run, because a partial run is not a result a
 * caller may treat as success.
 * @param activations - every activation of the run.
 * @returns the settled status, or `undefined` while any activation may still run.
 */
export function settleStatus(activations: readonly ActivationRow[]): RunStatus | undefined {
  let failed = false
  let canceled = false
  for (const activation of activations) {
    if (!isTerminal(activation.status)) return undefined
    if (activation.status === 'failed') failed = true
    if (activation.status === 'canceled') canceled = true
  }
  if (failed) return 'failed'
  return canceled ? 'canceled' : 'succeeded'
}

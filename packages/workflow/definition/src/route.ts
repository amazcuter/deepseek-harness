/**
 * Edge routing: turn one node result plus that node's outgoing edges into the
 * target set the scheduler activates. Routing reads only business fields of the
 * result, never control fields, and reports ambiguity instead of guessing.
 *
 * @module @metaworkflow/workflow-definition/route
 */

import type { JsonValue } from '@metaworkflow/util-values'
import { evaluatePredicate } from './predicate.ts'
import type { RoutingDiagnostic, RoutingFailure, RoutingResult, WorkflowEdge, WorkflowNode } from './types.ts'

/** One exclusive-group selection: the edge to activate, or why none was selected. */
type ExclusiveSelection =
  | { readonly kind: 'edge'; readonly edge: WorkflowEdge }
  | { readonly kind: 'failure'; readonly failure: RoutingFailure }

/**
 * Route one node result through the node's outgoing edges.
 *
 * Edges whose `from` is another node are ignored, so the whole definition edge
 * list may be passed. An exclusive group selects exactly one edge — the single
 * conditional match, else its fallback, else failure. Multiple-mode edges
 * activate independently and keep edge order. A failure yields no targets.
 *
 * @param result - the node's JSON result.
 * @param node - the node whose outgoing edges are routed.
 * @param edges - definition edges; only edges leaving `node` are considered.
 * @returns the activated targets, the activated edge ids, the loop activation count, diagnostics, and any failure.
 */
export function route(result: JsonValue, node: WorkflowNode, edges: readonly WorkflowEdge[]): RoutingResult {
  const outgoing = edges.filter(edge => edge.from === node.id)
  const diagnostics: RoutingDiagnostic[] = []
  const activated: WorkflowEdge[] = []
  const exclusiveEdges = outgoing.filter(edge => edge.mode === 'exclusive')
  const multipleEdges = outgoing.filter(edge => edge.mode === 'multiple')
  if (exclusiveEdges.length > 0) {
    const selection = selectExclusive(result, node, exclusiveEdges, diagnostics)
    if (selection.kind === 'failure') {
      return { targets: [], edgeIds: [], iterationDelta: 0, diagnostics, failure: selection.failure }
    }
    activated.push(selection.edge)
  }
  for (const edge of multipleEdges) {
    if (activates(result, edge, diagnostics)) activated.push(edge)
  }
  const targets: string[] = []
  for (const edge of activated) {
    if (!targets.includes(edge.to)) targets.push(edge.to)
  }
  return {
    targets,
    edgeIds: activated.map(edge => edge.id),
    iterationDelta: activated.filter(edge => edge.loop !== undefined).length,
    diagnostics,
    failure: null,
  }
}

/**
 * Resolve one exclusive edge group.
 * @param result - the node's JSON result.
 * @param node - the node whose outgoing edges are routed.
 * @param edges - the node's exclusive-mode outgoing edges.
 * @param diagnostics - accumulator for condition diagnostics.
 * @returns the selected edge, or the failure that prevents a decision.
 */
function selectExclusive(
  result: JsonValue,
  node: WorkflowNode,
  edges: readonly WorkflowEdge[],
  diagnostics: RoutingDiagnostic[],
): ExclusiveSelection {
  const fallback = edges.find(edge => edge.fallback === true)
  const matches: WorkflowEdge[] = []
  for (const edge of edges) {
    if (edge.fallback === true) continue
    if (activates(result, edge, diagnostics)) matches.push(edge)
  }
  const selected = matches[0]
  if (matches.length === 1 && selected !== undefined) return { kind: 'edge', edge: selected }
  if (matches.length === 0) {
    if (fallback !== undefined) return { kind: 'edge', edge: fallback }
    return {
      kind: 'failure',
      failure: {
        code: 'routing/no-match',
        nodeId: node.id,
        message: `no outgoing edge of node "${node.id}" matched the result`,
        candidates: [],
      },
    }
  }
  return {
    kind: 'failure',
    failure: {
      code: 'routing/ambiguous',
      nodeId: node.id,
      message: `${matches.length} outgoing edges of node "${node.id}" matched: ${matches.map(edge => edge.id).join(', ')}`,
      candidates: matches.map(edge => edge.id),
    },
  }
}

/**
 * Decide whether one edge activates, reporting the condition's diagnostics.
 * @param result - the node's JSON result.
 * @param edge - the candidate edge.
 * @param diagnostics - accumulator for condition diagnostics.
 * @returns whether the edge activates; a `null` condition always activates.
 */
function activates(result: JsonValue, edge: WorkflowEdge, diagnostics: RoutingDiagnostic[]): boolean {
  if (edge.condition === null) return true
  const evaluation = evaluatePredicate(result, edge.condition)
  for (const diagnostic of evaluation.diagnostics) diagnostics.push({ ...diagnostic, edgeId: edge.id })
  return evaluation.matched
}

/**
 * Flowchart translation: turn a parsed Mermaid flowchart into a workflow
 * definition the validator accepts, and report the node ids it generated.
 *
 * Every imported node is an agent node with a placeholder instruction, an empty
 * object result schema, and no inputs; every link becomes an exclusive edge
 * whose condition compares the run-scoped `route` field with the link label.
 * The translation refuses a cyclic flowchart instead of guessing which link is
 * a re-entry, and it never throws: a definition the validator rejects comes
 * back as violations.
 *
 * @module @metaworkflow/workflow-mermaid-import/definition
 */

import { validateDefinition } from '@metaworkflow/workflow-definition'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@metaworkflow/workflow-definition'
import type {
  MermaidFlowchartGraph,
  MermaidGraphError,
  MermaidNodeContext,
  MermaidWarning,
  ToDefinitionOptions,
  ToDefinitionResult,
} from './types.ts'

/** Field the generated conditions compare against the link label. */
const ROUTE_FIELD = 'route'

/**
 * Default instructions for an imported node: a placeholder a later pass or the
 * project owner replaces with the real task.
 * @param node - the node being translated.
 * @returns the instructions text stored on that node.
 */
function placeholderInstructions(node: MermaidNodeContext): string {
  return `Complete the "${node.label}" step.`
}

/**
 * Translate one parsed flowchart into a workflow definition.
 *
 * @param graph - the graph `parseMermaidFlowchart` returned, or an equivalent
 * caller-built graph.
 * @param options - instructions override for the generated agent nodes.
 * @returns the definition with its id mapping and warnings, or the reason the
 * graph cannot be imported (a cycle, or the validator's violations).
 */
export function toDefinition(
  graph: MermaidFlowchartGraph,
  options: ToDefinitionOptions = {},
): ToDefinitionResult {
  const cycle = findCycle(graph)
  if (cycle !== undefined) return { ok: false, error: cycleError(cycle), violations: [] }
  const warnings: MermaidWarning[] = []
  const mapping: Record<string, string> = {}
  const taken = new Set<string>()
  const instructions = options.instructions ?? placeholderInstructions
  const nodes = graph.nodes.map((node): WorkflowNode => {
    const base = slugOf(node.label)
    const id = uniqueSlug(base, taken)
    if (id !== base) {
      warnings.push({
        code: 'mermaid/label-collision',
        message: `the label ${JSON.stringify(node.label)} already produced node id "${base}"; this node became "${id}"`,
      })
    }
    mapping[node.id] = id
    return {
      id,
      kind: 'agent',
      title: node.label,
      config: {
        kind: 'agent',
        outputSchema: { type: 'object' },
        instructions: instructions({ mermaidId: node.id, id, label: node.label }),
        tools: [],
        memory: 'fresh',
      },
      inputs: [],
      join: 'all',
    }
  })
  const definition: WorkflowDefinition = { version: 1, nodes, edges: buildEdges(graph, mapping, warnings) }
  const validation = validateDefinition(definition)
  if (!validation.ok) return { ok: false, error: null, violations: validation.violations }
  return { ok: true, definition, mapping, warnings }
}

/**
 * Build the exclusive edges one flowchart's links produce.
 *
 * Repeating a link is dropped with a warning. An unlabelled link is a fallback
 * when its source also carries labelled links, so the labelled alternatives are
 * tried first; otherwise it activates unconditionally.
 *
 * @param graph - the parsed graph.
 * @param mapping - mermaid node id to generated node id.
 * @param warnings - accumulator for the warnings this pass reports.
 * @returns one edge per distinct link, in source order.
 */
function buildEdges(
  graph: MermaidFlowchartGraph,
  mapping: Readonly<Record<string, string>>,
  warnings: MermaidWarning[],
): WorkflowEdge[] {
  const conditionalSources = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.label !== undefined) conditionalSources.add(edge.from)
  }
  const seen = new Set<string>()
  const idCounts = new Map<string, number>()
  const edges: WorkflowEdge[] = []
  for (const edge of graph.edges) {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ''}`
    if (seen.has(key)) {
      warnings.push({
        code: 'mermaid/duplicate-edge',
        message: `the link from "${edge.from}" to "${edge.to}" is written more than once; the repeat was dropped`,
      })
      continue
    }
    seen.add(key)
    const from = mapping[edge.from] ?? ''
    const to = mapping[edge.to] ?? ''
    const fallback = edge.label === undefined && conditionalSources.has(edge.from)
    edges.push({
      id: uniqueEdgeId(`${from}-${to}`, idCounts),
      from,
      to,
      condition: edge.label === undefined ? null : { op: 'eq', field: ROUTE_FIELD, value: edge.label },
      mode: 'exclusive',
      ...fallback ? { fallback: true } : {},
    })
  }
  return edges
}

/**
 * Derive the stable node id a label slugifies to.
 * @param label - node label.
 * @returns an id matching `^[a-z][a-z0-9_-]*$`.
 */
function slugOf(label: string): string {
  const base = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
  if (base === '') return 'node'
  return /^[a-z]/u.test(base) ? base : `node-${base}`
}

/**
 * Reserve one slug, adding a numeric suffix while it is already taken.
 * @param base - slug the label produced.
 * @param taken - ids already reserved in this translation.
 * @returns the reserved id.
 */
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  const slug = `${base}-${index}`
  taken.add(slug)
  return slug
}

/**
 * Reserve one edge id, adding a numeric suffix while it is already taken.
 * @param base - id derived from the edge's endpoints.
 * @param counts - ids already reserved in this translation.
 * @returns the reserved id.
 */
function uniqueEdgeId(base: string, counts: Map<string, number>): string {
  const count = counts.get(base) ?? 0
  counts.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
}

/**
 * Find a directed cycle through the flowchart's links.
 * @param graph - the parsed graph.
 * @returns the node path that closes the cycle, or `undefined` when the graph is
 * acyclic.
 */
function findCycle(graph: MermaidFlowchartGraph): readonly string[] | undefined {
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.from)
    if (targets === undefined) outgoing.set(edge.from, [edge.to])
    else targets.push(edge.to)
  }
  const finished = new Set<string>()
  const active = new Set<string>()
  const path: string[] = []
  const visit = (id: string): readonly string[] | undefined => {
    active.add(id)
    path.push(id)
    for (const next of outgoing.get(id) ?? []) {
      if (active.has(next)) return [...path.slice(path.indexOf(next)), next]
      if (finished.has(next)) continue
      const found = visit(next)
      if (found !== undefined) return found
    }
    path.pop()
    active.delete(id)
    finished.add(id)
    return undefined
  }
  for (const node of graph.nodes) {
    if (finished.has(node.id)) continue
    const found = visit(node.id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Describe a cycle refusal.
 * @param cycle - the node path that closed the cycle.
 * @returns the refusal to report.
 */
function cycleError(cycle: readonly string[]): MermaidGraphError {
  return {
    code: 'mermaid/cycle-unsupported',
    message: `the flowchart is cyclic (${cycle.join(' → ')}); an imported definition runs each node once, so add the loop on the canvas instead`,
  }
}

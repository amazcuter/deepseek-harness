/**
 * The canvas's read of one stored definition document.
 *
 * `projects.definition` returns the canonical document text its nodes and edges
 * live in; the canvas needs the edges too, which the projected node views do not
 * carry. The document is JSON text that crossed the Remote, so this module
 * validates it instead of trusting the projection: a member it cannot read
 * makes the whole graph unavailable, and the canvas falls back to its empty
 * state rather than drawing a partial workflow.
 */

/** One node as the canvas draws it. */
export interface GraphNode {
  readonly id: string
  readonly title: string
}

/** One directed edge as the canvas draws it. */
export interface GraphEdge {
  readonly from: string
  readonly to: string
  /** Rendered condition text; empty when the edge activates unconditionally. */
  readonly label: string
}

/** The graph of one stored definition. */
export interface DefinitionGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

/** Comparison operators and the symbol an edge label shows for each. */
const COMPARISON_SYMBOL: Readonly<Record<string, string>> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
}

/**
 * Read one stored definition document into the graph the canvas draws.
 * @param document - canonical document text the Host projected, or `null` when
 * the project stores no definition.
 * @returns the graph, or `null` when the text is not a document this module can
 * draw: invalid JSON, a non-list `nodes`/`edges`, or a member without its ids.
 */
export function readDefinitionGraph(document: string | null): DefinitionGraph | null {
  if (document === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch (_invalidJson) {
    return null
  }
  if (!isRecord(parsed)) return null
  const nodes = readNodes(parsed['nodes'])
  const edges = readEdges(parsed['edges'])
  if (nodes === null || edges === null) return null
  return { nodes, edges }
}

/**
 * @param value - candidate `nodes` member.
 * @returns every node of one definition document, or `null` when the value is
 * not a list of identified nodes.
 */
function readNodes(value: unknown): GraphNode[] | null {
  if (!Array.isArray(value)) return null
  const nodes: GraphNode[] = []
  for (const member of value) {
    if (!isRecord(member)) return null
    const id = textOf(member['id'])
    const title = textOf(member['title'])
    if (id === null || title === null) return null
    nodes.push({ id, title })
  }
  return nodes
}

/**
 * @param value - candidate `edges` member.
 * @returns every edge of one definition document, or `null` when the value is
 * not a list of located edges.
 */
function readEdges(value: unknown): GraphEdge[] | null {
  if (!Array.isArray(value)) return null
  const edges: GraphEdge[] = []
  for (const member of value) {
    if (!isRecord(member)) return null
    const from = textOf(member['from'])
    const to = textOf(member['to'])
    if (from === null || to === null) return null
    edges.push({ from, to, label: conditionExpression(member['condition']) })
  }
  return edges
}

/**
 * Render one edge condition as the text its label shows.
 * The operators stay verbatim: they name the stored predicate's own vocabulary,
 * exactly like the field names and compared values beside them, so the drawing
 * reads the document rather than translating it.
 * @param condition - the edge's `condition` member: `null`, a field comparison,
 * or a combinator over nested predicates.
 * @returns the readable condition, or an empty string when the value is not a
 * predicate this module recognizes.
 */
export function conditionExpression(condition: unknown): string {
  if (condition === null || condition === undefined) return ''
  if (!isRecord(condition)) return ''
  const op = textOf(condition['op'])
  if (op === null) return ''
  if (op === 'and' || op === 'or') {
    const args = condition['args']
    if (!Array.isArray(args)) return ''
    const rendered = args.map(argument => conditionExpression(argument)).filter(text => text !== '')
    return rendered.length === 0 ? '' : rendered.join(` ${op} `)
  }
  if (op === 'not') {
    const argument = conditionExpression(condition['arg'])
    return argument === '' ? '' : `not ${argument}`
  }
  const field = textOf(condition['field'])
  if (field === null) return ''
  if (op === 'exists') return `${field} exists`
  if (op === 'truthy') return `${field} is truthy`
  if (op === 'in' || op === 'not-in') {
    const value = condition['value']
    if (!Array.isArray(value)) return ''
    return `${field} ${op} ${value.map(member => literalText(member)).join(', ')}`
  }
  const symbol = COMPARISON_SYMBOL[op]
  if (symbol === undefined) return ''
  return `${field} ${symbol} ${literalText(condition['value'])}`
}

/**
 * @param value - one JSON value compared by a condition.
 * @returns the value as expression text; strings lose their surrounding quotes.
 */
function literalText(value: unknown): string {
  if (typeof value === 'string') return value
  // `JSON.stringify` answers `undefined` for values JSON cannot represent.
  const encoded = JSON.stringify(value) as string | undefined
  return encoded ?? ''
}

/**
 * @param value - candidate text member.
 * @returns the string when the member is one, otherwise `null`.
 */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * @param value - candidate JSON value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

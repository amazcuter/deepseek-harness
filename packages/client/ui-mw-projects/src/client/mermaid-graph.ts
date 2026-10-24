/**
 * Mermaid flowchart source for one stored definition graph.
 *
 * The canvas draws a workflow by asking Mermaid to lay out the definition as a
 * `flowchart TD`: one node per definition node, one arrow per edge, and the
 * condition text on every conditioned arrow. Mermaid ids are not definition ids
 * in general — a definition id may carry `-`, which Mermaid reads as syntax — so
 * the source keeps a map from the id it emitted to the definition node it draws,
 * and the canvas resolves a rendered `g.node` through that map.
 */

import type { DefinitionGraph, GraphNode } from './definition-graph.ts'

/** One generated flowchart source and the node mapping it renders through. */
export interface FlowchartSource {
  /** Mermaid source text. */
  readonly text: string
  /** Mermaid node id to the definition node it draws. */
  readonly nodeIds: ReadonlyMap<string, GraphNode>
}

/** Node ids Mermaid reads as one identifier rather than as several tokens. */
const BARE_ID = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Build the flowchart source that draws one definition graph.
 * @param graph - the definition graph read from the stored document.
 * @returns the source text and the mapping its rendered nodes resolve through.
 */
export function flowchartSource(graph: DefinitionGraph): FlowchartSource {
  const lines = ['flowchart TD']
  const nodeIds = new Map<string, GraphNode>()
  const mermaidIds = new Map<string, string>()
  for (const [index, node] of graph.nodes.entries()) {
    const mermaidId = bareId(node.id, index, nodeIds)
    nodeIds.set(mermaidId, node)
    mermaidIds.set(node.id, mermaidId)
    lines.push(`  ${mermaidId}["${escapeLabel(node.title)}"]`)
  }
  for (const edge of graph.edges) {
    const from = mermaidIds.get(edge.from)
    const to = mermaidIds.get(edge.to)
    // An edge whose endpoint the document does not declare draws nothing; the
    // Host validator rejects such documents, so this only guards a partial read.
    if (from === undefined || to === undefined) continue
    const label = edge.label.trim()
    lines.push(label === ''
      ? `  ${from} --> ${to}`
      : `  ${from} -->|"${escapeLabel(label)}"| ${to}`)
  }
  return { text: `${lines.join('\n')}\n`, nodeIds }
}

/**
 * @param id - definition node id.
 * @param index - position of the node in the definition.
 * @param taken - mermaid ids already emitted.
 * @returns an id Mermaid reads as one identifier and no other node uses.
 */
function bareId(id: string, index: number, taken: ReadonlyMap<string, GraphNode>): string {
  if (BARE_ID.test(id) && !taken.has(id)) return id
  const base = `n${index}`
  let candidate = base
  for (let suffix = 1; taken.has(candidate); suffix += 1) candidate = `${base}_${suffix}`
  return candidate
}

/** Substitutions keeping a title's own text out of Mermaid's syntax. */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/\r\n?|\n/g, ' '],
  [/#/g, '#35;'],
  [/&/g, '#38;'],
  [/"/g, '#quot;'],
  [/</g, '#lt;'],
  [/>/g, '#gt;'],
  [/\|/g, '#124;'],
]

/**
 * @param text - a node title or edge label.
 * @returns the text as one safe Mermaid label body: newlines collapse to a
 * space, and each character Mermaid terminates or nests syntax with becomes its
 * entity form.
 */
function escapeLabel(text: string): string {
  let escaped = text
  for (const [pattern, entity] of ENTITIES) escaped = escaped.replace(pattern, entity)
  return escaped
}

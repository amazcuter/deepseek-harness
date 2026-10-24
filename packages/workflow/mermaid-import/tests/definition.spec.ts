import { describe, expect, it } from 'vitest'
import { validateDefinition } from '@metaworkflow/workflow-definition'
import { toDefinition } from '../src/definition.ts'
import { parseMermaidFlowchart } from '../src/parse.ts'
import type { MermaidFlowchartGraph, ToDefinitionResult } from '../src/types.ts'

/**
 * Parse valid flowchart text.
 * @param text - flowchart source.
 * @returns the parsed graph.
 */
function graphOf(text: string): MermaidFlowchartGraph {
  const result = parseMermaidFlowchart(text)
  if (!result.ok) throw new Error(`expected a parsed flowchart, got ${result.error.code}: ${result.error.message}`)
  return result.graph
}

/**
 * Translate valid flowchart text, requiring success.
 * @param text - flowchart source.
 * @returns the successful translation.
 */
function translated(text: string): Extract<ToDefinitionResult, { readonly ok: true }> {
  const result = toDefinition(graphOf(text))
  if (!result.ok) throw new Error(`expected a definition, got ${JSON.stringify(result)}`)
  return result
}

/**
 * Build a graph value directly, for inputs no parsed flowchart produces.
 * @param graph - nodes and edges of the caller-built graph.
 * @returns the graph value.
 */
function rawGraph(
  nodes: readonly { readonly id: string; readonly label?: string }[],
  edges: readonly { readonly from: string; readonly to: string; readonly label?: string }[],
): MermaidFlowchartGraph {
  return {
    direction: 'TD',
    nodes: nodes.map(node => ({ id: node.id, label: node.label ?? node.id, line: 1 })),
    edges: edges.map(edge => ({ ...edge, line: 1 })),
  }
}

describe('toDefinition', () => {
  it('turns every node into an agent node and every link into an exclusive edge', () => {
    const result = translated(`flowchart TD
      Start[Fetch the invoice] --> Review{Review}
      Review -->|approved| Done(File it)
      Review -->|rejected| Rework[Send it back]`)

    expect(validateDefinition(result.definition)).toEqual({ ok: true })
    expect(result.mapping).toEqual({ Start: 'fetch-the-invoice', Review: 'review', Done: 'file-it', Rework: 'send-it-back' })
    expect(result.warnings).toEqual([])
    expect(result.definition.version).toBe(1)
    expect(result.definition.nodes.map(node => [node.id, node.title, node.kind])).toEqual([
      ['fetch-the-invoice', 'Fetch the invoice', 'agent'],
      ['review', 'Review', 'agent'],
      ['file-it', 'File it', 'agent'],
      ['send-it-back', 'Send it back', 'agent'],
    ])
    expect(result.definition.nodes[0]?.config).toEqual({
      kind: 'agent',
      outputSchema: { type: 'object' },
      instructions: 'Complete the "Fetch the invoice" step.',
      tools: [],
      memory: 'fresh',
    })
    expect(result.definition.nodes[0]?.inputs).toEqual([])
    expect(result.definition.nodes[0]?.join).toBe('all')
    expect(result.definition.edges).toEqual([
      { id: 'fetch-the-invoice-review', from: 'fetch-the-invoice', to: 'review', condition: null, mode: 'exclusive' },
      {
        id: 'review-file-it',
        from: 'review',
        to: 'file-it',
        condition: { op: 'eq', field: 'route', value: 'approved' },
        mode: 'exclusive',
      },
      {
        id: 'review-send-it-back',
        from: 'review',
        to: 'send-it-back',
        condition: { op: 'eq', field: 'route', value: 'rejected' },
        mode: 'exclusive',
      },
    ])
  })

  it('makes an unlabelled link the fallback when its source also has labelled links', () => {
    const result = translated(`flowchart TD
      Start[Start] --> Check{Check}
      Check -->|retry| Rework[Rework]
      Check --> Done[Done]`)
    const edges = result.definition.edges
    expect(edges).toEqual([
      { id: 'start-check', from: 'start', to: 'check', condition: null, mode: 'exclusive' },
      {
        id: 'check-rework',
        from: 'check',
        to: 'rework',
        condition: { op: 'eq', field: 'route', value: 'retry' },
        mode: 'exclusive',
      },
      { id: 'check-done', from: 'check', to: 'done', condition: null, mode: 'exclusive', fallback: true },
    ])
    expect(edges[1]?.loop).toBeUndefined()
  })

  it('derives stable slugs and dedupes collisions with numeric suffixes', () => {
    const result = toDefinition(rawGraph(
      [
        { id: 'A', label: 'Review step #2' },
        { id: 'B', label: 'review step #2' },
        { id: 'C', label: 'Review step #2' },
        { id: 'D', label: '  Fetch_invoice  ' },
        { id: 'E', label: '开始' },
        { id: 'F', label: '3 steps' },
        { id: 'G', label: '--Edge-- case' },
      ],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
        { from: 'D', to: 'E' },
        { from: 'E', to: 'F' },
        { from: 'F', to: 'G' },
      ],
    ))
    if (!result.ok) throw new Error('expected a definition')
    expect(result.mapping).toEqual({
      A: 'review-step-2',
      B: 'review-step-2-2',
      C: 'review-step-2-3',
      D: 'fetch_invoice',
      E: 'node',
      F: 'node-3-steps',
      G: 'edge-case',
    })
    expect(result.warnings.map(warning => warning.code)).toEqual(['mermaid/label-collision', 'mermaid/label-collision'])
    expect(result.warnings[0]?.message).toContain('review-step-2-2')
    expect(result.definition.nodes.map(node => node.id)).toEqual([
      'review-step-2',
      'review-step-2-2',
      'review-step-2-3',
      'fetch_invoice',
      'node',
      'node-3-steps',
      'edge-case',
    ])
  })

  it('suffixes an edge id that two links between the same nodes would share', () => {
    const result = translated(`flowchart TD
      A[One] -->|yes| B[Two]
      A -->|no| B`)
    if (!result.ok) throw new Error('expected a definition')
    expect(result.definition.edges.map(edge => edge.id)).toEqual(['one-two', 'one-two-2'])
    expect(result.definition.edges.map(edge => edge.condition)).toEqual([
      { op: 'eq', field: 'route', value: 'yes' },
      { op: 'eq', field: 'route', value: 'no' },
    ])
  })

  it('drops a repeated link with a warning', () => {
    const result = toDefinition(rawGraph(
      [{ id: 'A', label: 'One' }, { id: 'B', label: 'Two' }],
      [
        { from: 'A', to: 'B', label: 'yes' },
        { from: 'A', to: 'B', label: 'yes' },
      ],
    ))
    if (!result.ok) throw new Error('expected a definition')
    expect(result.definition.edges).toHaveLength(1)
    expect(result.warnings).toEqual([
      { code: 'mermaid/duplicate-edge', message: 'the link from "A" to "B" is written more than once; the repeat was dropped' },
    ])
  })

  it('uses caller-supplied instructions when the options carry a builder', () => {
    const result = toDefinition(graphOf(`flowchart TD
      A[First] --> B[Second]`), {
      instructions: node => `Do ${node.label} (${node.mermaidId} -> ${node.id}).`,
    })
    if (!result.ok) throw new Error('expected a definition')
    expect(result.definition.nodes.map(node => (node.config.kind === 'agent' ? node.config.instructions : ''))).toEqual([
      'Do First (A -> first).',
      'Do Second (B -> second).',
    ])
  })

  it('refuses a cyclic flowchart and names the cycle', () => {
    const result = toDefinition(graphOf(`flowchart TD
      A[One] --> B[Two]
      B --> A`))
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'mermaid/cycle-unsupported',
        message: 'the flowchart is cyclic (A → B → A); an imported definition runs each node once, so add the loop on the canvas instead',
      },
      violations: [],
    })
  })

  it('refuses a self link as a cycle', () => {
    const result = toDefinition(rawGraph([{ id: 'A', label: 'One' }], [{ from: 'A', to: 'A' }]))
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error?.code).toBe('mermaid/cycle-unsupported')
  })

  it('returns the validator violations instead of throwing', () => {
    const result = toDefinition(graphOf(`flowchart TD
      A[One] --> C[Three]
      B[Two] --> C`))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBeNull()
    expect(result.violations.map(violation => violation.code)).toContain('definition/multiple-entry-nodes')
  })

  it('refuses a flowchart with no nodes', () => {
    const result = toDefinition(graphOf('flowchart TD'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.violations.map(violation => violation.code)).toEqual(['definition/no-entry-node'])
  })

  it('reports a caller-built edge that names no declared node', () => {
    const unknownSource = toDefinition(rawGraph(
      [{ id: 'B', label: 'Two' }],
      [{ from: 'Missing', to: 'B' }],
    ))
    expect(unknownSource.ok).toBe(false)
    if (unknownSource.ok) throw new Error('expected a refusal')
    expect(unknownSource.violations.map(violation => violation.code)).toContain('definition/edge-endpoint-missing')

    const unknownTarget = toDefinition(rawGraph(
      [{ id: 'A', label: 'One' }],
      [{ from: 'A', to: 'Missing' }],
    ))
    expect(unknownTarget.ok).toBe(false)
    if (unknownTarget.ok) throw new Error('expected a refusal')
    expect(unknownTarget.violations.map(violation => violation.code)).toContain('definition/edge-endpoint-missing')
  })

  it('accepts a graph whose shared descendant is reached once', () => {
    const result = toDefinition(graphOf(`flowchart TD
      A[One] --> B[Two]
      A --> C[Three]
      B --> D[Four]
      C --> D`))
    expect(result.ok).toBe(true)
  })
})

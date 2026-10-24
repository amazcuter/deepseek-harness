/**
 * The generated Mermaid source: one node line per definition node, one arrow per
 * edge with its condition as the label, and the id map the canvas resolves its
 * drawn nodes through.
 */
import { describe, expect, it } from 'vitest'
import type { DefinitionGraph } from '../src/client/definition-graph.ts'
import { flowchartSource } from '../src/client/mermaid-graph.ts'

/** One graph from the given nodes and edges. */
function graphOf(
  nodes: DefinitionGraph['nodes'],
  edges: DefinitionGraph['edges'] = [],
): DefinitionGraph {
  return { nodes, edges }
}

describe('flowchartSource', () => {
  it('draws one top-down node line per node and keeps the definition ids', () => {
    const source = flowchartSource(graphOf([
      { id: 'fetch', title: '抓取' },
      { id: 'review', title: '评审' },
    ]))
    expect(source.text).toBe('flowchart TD\n  fetch["抓取"]\n  review["评审"]\n')
    expect([...source.nodeIds]).toEqual([
      ['fetch', { id: 'fetch', title: '抓取' }],
      ['review', { id: 'review', title: '评审' }],
    ])
  })

  it('labels a conditioned edge and leaves an unconditional one bare', () => {
    const source = flowchartSource(graphOf(
      [{ id: 'fetch', title: '抓取' }, { id: 'review', title: '评审' }],
      [
        { from: 'fetch', to: 'review', label: '' },
        { from: 'review', to: 'fetch', label: 'ok = true' },
      ],
    ))
    expect(source.text.split('\n')).toEqual([
      'flowchart TD',
      '  fetch["抓取"]',
      '  review["评审"]',
      '  fetch --> review',
      '  review -->|"ok = true"| fetch',
      '',
    ])
  })

  it('rewrites an id Mermaid reads as syntax and maps the drawn id back', () => {
    const source = flowchartSource(graphOf([
      { id: 'fetch-1', title: '抓取' },
      { id: '2bad', title: '评审' },
      { id: 'n0', title: '归档' },
    ]))
    expect(source.text.split('\n').slice(1, 4)).toEqual([
      '  n0["抓取"]',
      '  n1["评审"]',
      '  n2["归档"]',
    ])
    expect([...source.nodeIds]).toEqual([
      ['n0', { id: 'fetch-1', title: '抓取' }],
      ['n1', { id: '2bad', title: '评审' }],
      ['n2', { id: 'n0', title: '归档' }],
    ])
  })

  it('keeps a generated id clear of a bare id another node already claimed', () => {
    const source = flowchartSource(graphOf([
      { id: 'n2', title: 'A' },
      { id: 'other', title: 'B' },
      { id: 'x-y', title: 'C' },
    ]))
    expect(source.text.split('\n').slice(1, 4)).toEqual([
      '  n2["A"]',
      '  other["B"]',
      '  n2_1["C"]',
    ])
    expect([...source.nodeIds]).toEqual([
      ['n2', { id: 'n2', title: 'A' }],
      ['other', { id: 'other', title: 'B' }],
      ['n2_1', { id: 'x-y', title: 'C' }],
    ])
  })

  it('escapes the characters that end or nest Mermaid syntax', () => {
    const source = flowchartSource(graphOf(
      [{ id: 'a', title: 'a "quoted" | pipe & <tag> #1\nsecond line' }],
      [{ from: 'a', to: 'a', label: 'ok "x" | y' }],
    ))
    expect(source.text.split('\n')).toEqual([
      'flowchart TD',
      '  a["a #quot;quoted#quot; #124; pipe #38; #lt;tag#gt; #35;1 second line"]',
      '  a -->|"ok #quot;x#quot; #124; y"| a',
      '',
    ])
  })

  it('drops an edge whose endpoint the document does not declare', () => {
    const source = flowchartSource(graphOf(
      [{ id: 'a', title: 'A' }],
      [{ from: 'a', to: 'missing', label: '' }],
    ))
    expect(source.text).toBe('flowchart TD\n  a["A"]\n')
  })
})

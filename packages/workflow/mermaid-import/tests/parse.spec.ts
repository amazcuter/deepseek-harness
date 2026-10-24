import { describe, expect, it } from 'vitest'
import { parseMermaidFlowchart } from '../src/parse.ts'
import type { MermaidParseError, MermaidParseResult } from '../src/types.ts'

/**
 * Parse text that must succeed.
 * @param text - flowchart source.
 * @returns the successful parse result.
 */
function parsed(text: string): Extract<MermaidParseResult, { ok: true }> {
  const result = parseMermaidFlowchart(text)
  if (!result.ok) throw new Error(`expected a parsed flowchart, got ${result.error.code}: ${result.error.message}`)
  return result
}

/**
 * Parse text that must be refused.
 * @param text - flowchart source.
 * @returns the refusal.
 */
function refused(text: string): MermaidParseError {
  const result = parseMermaidFlowchart(text)
  if (result.ok) throw new Error('expected the parse to be refused')
  return result.error
}

describe('parseMermaidFlowchart', () => {
  it('reads the four supported directions from both header keywords', () => {
    for (const [keyword, direction] of [
      ['flowchart', 'TD'],
      ['flowchart', 'LR'],
      ['graph', 'BT'],
      ['graph', 'RL'],
    ] as const) {
      expect(parsed(`${keyword} ${direction}`).graph.direction).toBe(direction)
    }
  })

  it('reads node statements and links in source order', () => {
    const { graph, warnings } = parsed(`flowchart TD
      Start[Fetch the invoice] --> Review{Review}
      Review -->|approved| Done(File it)
      Review --- Archive[Archived]`)
    expect(graph.nodes).toEqual([
      { id: 'Start', label: 'Fetch the invoice', line: 2 },
      { id: 'Review', label: 'Review', line: 2 },
      { id: 'Done', label: 'File it', line: 3 },
      { id: 'Archive', label: 'Archived', line: 4 },
    ])
    expect(graph.edges).toEqual([
      { from: 'Start', to: 'Review', line: 2 },
      { from: 'Review', to: 'Done', label: 'approved', line: 3 },
      { from: 'Review', to: 'Archive', line: 4 },
    ])
    expect(warnings).toEqual([])
  })

  it('reads a chained statement as one link per pair', () => {
    const { graph } = parsed(`flowchart LR
      A[One] --> B[Two] --> C[Three] --> D`)
    expect(graph.edges.map(edge => [edge.from, edge.to])).toEqual([
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
    ])
    expect(graph.nodes.map(node => node.label)).toEqual(['One', 'Two', 'Three', 'D'])
  })

  it('binds a pipe label to the link that carries it', () => {
    const { graph } = parsed(`flowchart TD
      A -->|first| B --> C`)
    expect(graph.edges).toEqual([
      { from: 'A', to: 'B', label: 'first', line: 2 },
      { from: 'B', to: 'C', line: 2 },
    ])
  })

  it('accepts a labelled line link and quoted labels', () => {
    const { graph } = parsed(`flowchart BT
      A["Step "one""] ---|note| B{Pick "two"}`)
    expect(graph.nodes).toEqual([
      { id: 'A', label: 'Step "one"', line: 2 },
      { id: 'B', label: 'Pick "two"', line: 2 },
    ])
    expect(graph.edges[0]).toEqual({ from: 'A', to: 'B', label: 'note', line: 2 })
  })

  it('accepts whitespace between an id and its shape, and around a link label', () => {
    const { graph } = parsed(`flowchart TD
      A [Spaced] --> |picked| B (Rounded)`)
    expect(graph.nodes.map(node => node.label)).toEqual(['Spaced', 'Rounded'])
    expect(graph.edges[0]?.label).toBe('picked')
  })

  it('ignores comment lines, blank lines, and a trailing semicolon', () => {
    const { graph } = parsed(`%% a leading comment

flowchart TD
%% between statements
  A[One] --> B[Two];
${'  '}
%% trailing comment`)
    expect(graph.nodes.map(node => node.id)).toEqual(['A', 'B'])
    expect(graph.edges).toHaveLength(1)
  })

  it('accepts CRLF line endings and keeps line numbers', () => {
    const { graph } = parsed('flowchart TD\r\n  A\r\n  A --> B\r\n')
    expect(graph.nodes).toEqual([
      { id: 'A', label: 'A', line: 2 },
      { id: 'B', label: 'B', line: 3 },
    ])
    expect(graph.edges[0]?.line).toBe(3)
  })

  it('merges a repeated node id and keeps the richest label', () => {
    const { graph, warnings } = parsed(`flowchart TD
      A --> B
      A[Shared start] --> C
      A[Shared start] --> D`)
    expect(graph.nodes.map(node => [node.id, node.label])).toEqual([
      ['A', 'Shared start'],
      ['B', 'B'],
      ['C', 'C'],
      ['D', 'D'],
    ])
    expect(warnings).toEqual([
      { code: 'mermaid/implicit-node', message: 'node "B" is only named by links, so it was created with its id as the title' },
      { code: 'mermaid/implicit-node', message: 'node "C" is only named by links, so it was created with its id as the title' },
      { code: 'mermaid/implicit-node', message: 'node "D" is only named by links, so it was created with its id as the title' },
    ])
  })

  it('refuses a repeated node id that carries a conflicting label', () => {
    const error = refused(`flowchart TD
      A[First]
      A[Second]`)
    expect(error).toMatchObject({ code: 'mermaid/duplicate-node', line: 3 })
    expect(error.message).toContain('line 2')
  })

  it('warns about a node only links name and never warns about a declared one', () => {
    const { warnings } = parsed(`flowchart TD
      Start[Begin] --> Middle
      Isolated
      Middle --> End[Done]`)
    expect(warnings).toEqual([
      { code: 'mermaid/implicit-node', message: 'node "Middle" is only named by links, so it was created with its id as the title' },
    ])
  })

  it('refuses text with no header', () => {
    expect(refused('A --> B')).toMatchObject({
      code: 'mermaid/missing-header',
      line: 1,
      message: 'the first statement must be a "flowchart" or "graph" header naming TD, LR, BT, or RL',
    })
    expect(refused('')).toEqual({
      code: 'mermaid/missing-header',
      message: 'the text declares no "flowchart" or "graph" header',
      line: 1,
    })
    expect(refused('%% only a comment').code).toBe('mermaid/missing-header')
  })

  it('refuses a header that names no direction or an unsupported one', () => {
    expect(refused('flowchart\n  A')).toMatchObject({
      code: 'mermaid/invalid-direction',
      line: 1,
      message: 'the header must name a direction: TD, LR, BT, or RL',
    })
    expect(refused('graph TD extra')).toMatchObject({
      code: 'mermaid/invalid-direction',
      line: 1,
      message: 'unsupported flowchart direction "TD extra"; use TD, LR, BT, or RL',
    })
    expect(refused('flowchart TB').code).toBe('mermaid/invalid-direction')
  })

  it('refuses every statement outside the subset with its line number', () => {
    const cases = [
      'subgraph one',
      'classDef plain fill:#fff',
      'class A plain',
      'click A call callback()',
      'style A fill:#fff',
      'linkStyle 0 stroke:#fff',
      'accTitle Title',
      'accDescr Description',
      'direction LR',
      'classDef',
    ]
    for (const statement of cases) {
      const error = refused(`flowchart TD\n  A[One]\n  ${statement}`)
      expect(error).toMatchObject({ code: 'mermaid/unsupported-syntax', line: 3 })
      expect(error.message).toContain(statement.split(' ')[0])
    }
  })

  it('refuses unsupported link forms', () => {
    for (const link of ['-.->', '==>', '-.-', '~~~', '--o', '--x', '-- text -->']) {
      const error = refused(`flowchart TD\n  A ${link} B`)
      expect(error).toMatchObject({ code: 'mermaid/unsupported-syntax', line: 2 })
      expect(error.message).toContain('unsupported link')
    }
  })

  it('refuses a statement that names no node and one that names no arrow', () => {
    expect(refused('flowchart TD\n  [Label]')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'expected a node id at column 1; ids use letters, digits, and underscore',
    })
    expect(refused('flowchart TD\n  A B')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'expected an arrow "-->" or a line "---" between two nodes',
    })
    expect(refused('flowchart TD\n  A -->')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'expected a node id at column 6; ids use letters, digits, and underscore',
    })
  })

  it('refuses unbalanced shapes and pipe labels', () => {
    expect(refused('flowchart TD\n  A[Open')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'node "A" opens its label with "[" but never closes it with "]"',
    })
    expect(refused('flowchart TD\n  A -->|open B')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'a link label opens with "|" but never closes with "|"',
    })
  })

  it('refuses empty labels', () => {
    expect(refused('flowchart TD\n  A[]')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'node "A" declares an empty label',
    })
    expect(refused('flowchart TD\n  A -->|| B')).toMatchObject({
      code: 'mermaid/syntax-error',
      line: 2,
      message: 'a link label between pipes must not be empty',
    })
  })

  it('reads a standalone node, repeating a standalone mention without a warning', () => {
    const { graph, warnings } = parsed(`flowchart TD
      A
      A`)
    expect(graph.nodes).toEqual([{ id: 'A', label: 'A', line: 2 }])
    expect(graph.edges).toEqual([])
    expect(warnings).toEqual([])
  })

  it('reads no nodes from a header alone', () => {
    expect(parsed('flowchart TD').graph).toEqual({ direction: 'TD', nodes: [], edges: [] })
  })
})

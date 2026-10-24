/**
 * The canvas's read of a stored definition document: the nodes and edges it
 * draws, the condition text it labels each conditioned edge with, and every
 * document the reader refuses.
 */
import { describe, expect, it } from 'vitest'
import { conditionExpression, readDefinitionGraph } from '../src/client/definition-graph.ts'

/** One document text from the given members. */
function documentOf(members: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, ...members })
}

describe('readDefinitionGraph', () => {
  it('reads the node titles and the edge endpoints of a stored document', () => {
    const graph = readDefinitionGraph(documentOf({
      nodes: [
        { id: 'fetch', title: '抓取', kind: 'python' },
        { id: 'review', title: '评审', kind: 'agent' },
      ],
      edges: [
        { id: 'fetch-review', from: 'fetch', to: 'review', condition: null },
        {
          id: 'review-done',
          from: 'review',
          to: 'fetch',
          condition: { op: 'eq', field: 'ok', value: true },
          loop: { maxIterations: 2 },
        },
      ],
    }))
    expect(graph).toEqual({
      nodes: [{ id: 'fetch', title: '抓取' }, { id: 'review', title: '评审' }],
      edges: [
        { from: 'fetch', to: 'review', label: '' },
        { from: 'review', to: 'fetch', label: 'ok = true' },
      ],
    })
  })

  it('reads an empty document as an empty graph', () => {
    expect(readDefinitionGraph(documentOf({ nodes: [], edges: [] })))
      .toEqual({ nodes: [], edges: [] })
  })

  it('reads no graph when the project stores no definition', () => {
    expect(readDefinitionGraph(null)).toBeNull()
  })

  it('reads no graph from text that is not JSON', () => {
    expect(readDefinitionGraph('version: 1')).toBeNull()
  })

  it('reads no graph from a document that is not an object', () => {
    expect(readDefinitionGraph('[]')).toBeNull()
  })

  it('reads no graph from a document without node and edge lists', () => {
    expect(readDefinitionGraph('{}')).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ edges: [] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: {}, edges: [] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [], edges: 'none' }))).toBeNull()
  })

  it('reads no graph from a node without its id or title', () => {
    expect(readDefinitionGraph(documentOf({ nodes: ['fetch'], edges: [] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [{ id: 'fetch' }], edges: [] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [{ title: '抓取' }], edges: [] }))).toBeNull()
  })

  it('reads no graph from an edge without its endpoints', () => {
    expect(readDefinitionGraph(documentOf({ nodes: [], edges: ['fetch'] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [], edges: [{ from: 'fetch' }] }))).toBeNull()
    expect(readDefinitionGraph(documentOf({ nodes: [], edges: [{ from: 'fetch', to: 2 }] }))).toBeNull()
  })
})

describe('conditionExpression', () => {
  it('renders an unconditional edge with no label', () => {
    expect(conditionExpression(null)).toBe('')
    expect(conditionExpression(undefined)).toBe('')
  })

  it('renders comparisons with the symbol each operator reads as', () => {
    expect(conditionExpression({ op: 'eq', field: 'status', value: 'ok' })).toBe('status = ok')
    expect(conditionExpression({ op: 'ne', field: 'status', value: 'ok' })).toBe('status ≠ ok')
    expect(conditionExpression({ op: 'gt', field: 'score', value: 3 })).toBe('score > 3')
    expect(conditionExpression({ op: 'gte', field: 'score', value: 3 })).toBe('score ≥ 3')
    expect(conditionExpression({ op: 'lt', field: 'score', value: 3 })).toBe('score < 3')
    expect(conditionExpression({ op: 'lte', field: 'score', value: 3 })).toBe('score ≤ 3')
  })

  it('renders the membership and existence operators', () => {
    expect(conditionExpression({ op: 'in', field: 'grade', value: ['a', 'b'] })).toBe('grade in a, b')
    expect(conditionExpression({ op: 'not-in', field: 'grade', value: [1, 2] })).toBe('grade not-in 1, 2')
    expect(conditionExpression({ op: 'exists', field: 'note' })).toBe('note exists')
    expect(conditionExpression({ op: 'truthy', field: 'ok' })).toBe('ok is truthy')
  })

  it('renders combinations and negation', () => {
    expect(conditionExpression({
      op: 'and',
      args: [{ op: 'eq', field: 'a', value: 1 }, { op: 'truthy', field: 'b' }],
    })).toBe('a = 1 and b is truthy')
    expect(conditionExpression({
      op: 'or',
      args: [{ op: 'exists', field: 'a' }, { op: 'not', arg: { op: 'exists', field: 'b' } }],
    })).toBe('a exists or not b exists')
  })

  it('renders no label for a predicate it cannot read', () => {
    expect(conditionExpression([])).toBe('')
    expect(conditionExpression({ field: 'a' })).toBe('')
    expect(conditionExpression({ op: 'and' })).toBe('')
    expect(conditionExpression({ op: 'and', args: [null] })).toBe('')
    expect(conditionExpression({ op: 'not' })).toBe('')
    expect(conditionExpression({ op: 'exists' })).toBe('')
    expect(conditionExpression({ op: 'in', field: 'a' })).toBe('')
    expect(conditionExpression({ op: 'approx', field: 'a', value: 1 })).toBe('')
    expect(conditionExpression({ op: 'eq', field: 'a', value: null })).toBe('a = null')
    expect(conditionExpression({ op: 'eq', field: 'a' })).toBe('a = ')
  })
})

import { describe, expect, it } from 'vitest'
import { route } from '../src/route.ts'
import type { WorkflowEdge, WorkflowNode } from '../src/types.ts'

/**
 * Build one typed node.
 * @param id - node id.
 * @returns a minimal python node.
 */
function node(id: string): WorkflowNode {
  return {
    id,
    kind: 'python',
    title: `Run ${id}`,
    config: { kind: 'python', source: `def nodemain_${id}(` },
    inputs: [],
    join: 'all',
  }
}

/**
 * Build one typed edge.
 * @param id - edge id.
 * @param from - source node id.
 * @param to - target node id.
 * @param extra - overriding fields.
 * @returns a multiple-mode unconditional edge by default.
 */
function edge(id: string, from: string, to: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return { id, from, to, condition: null, mode: 'multiple', ...extra }
}

const SOURCE = node('source')

describe('route', () => {
  it('selects the single matching exclusive edge', () => {
    const result = route({ score: 5 }, SOURCE, [
      edge('high', 'source', 'high', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 3 } }),
      edge('low', 'source', 'low', { mode: 'exclusive', condition: { op: 'lte', field: 'score', value: 3 } }),
    ])
    expect(result).toEqual({ targets: ['high'], edgeIds: ['high'], iterationDelta: 0, diagnostics: [], failure: null })
  })

  it('selects the fallback when no exclusive condition matches', () => {
    const result = route({ score: 1 }, SOURCE, [
      edge('high', 'source', 'high', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 3 } }),
      edge('fallback', 'source', 'fallback', { mode: 'exclusive', fallback: true }),
    ])
    expect(result.targets).toEqual(['fallback'])
    expect(result.edgeIds).toEqual(['fallback'])
    expect(result.failure).toBeNull()
  })

  it('does not evaluate a fallback condition', () => {
    const result = route({ score: 1 }, SOURCE, [
      edge('high', 'source', 'high', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 3 } }),
      edge('fallback', 'source', 'fallback', { mode: 'exclusive', fallback: true, condition: { op: 'gt', field: 'score', value: 'x' } }),
    ])
    expect(result.targets).toEqual(['fallback'])
    expect(result.diagnostics).toEqual([])
  })

  it('counts a loop fallback as one iteration', () => {
    const result = route({}, SOURCE, [
      edge('retry', 'source', 'source', { mode: 'exclusive', fallback: true, loop: { maxIterations: 2 } }),
    ])
    expect(result.iterationDelta).toBe(1)
  })

  it('reports no-match when nothing matches and no fallback exists', () => {
    const result = route({ score: 1 }, SOURCE, [
      edge('high', 'source', 'high', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 3 } }),
    ])
    expect(result).toEqual({
      targets: [],
      edgeIds: [],
      iterationDelta: 0,
      diagnostics: [],
      failure: {
        code: 'routing/no-match',
        nodeId: 'source',
        message: 'no outgoing edge of node "source" matched the result',
        candidates: [],
      },
    })
  })

  it('reports ambiguity with every candidate edge in document order', () => {
    const result = route({ a: 1, b: 2 }, SOURCE, [
      edge('first', 'source', 'one', { mode: 'exclusive', condition: { op: 'eq', field: 'a', value: 1 } }),
      edge('second', 'source', 'two', { mode: 'exclusive', condition: { op: 'eq', field: 'b', value: 2 } }),
    ])
    expect(result.targets).toEqual([])
    expect(result.failure?.code).toBe('routing/ambiguous')
    expect(result.failure?.candidates).toEqual(['first', 'second'])
    expect(result.failure?.message).toContain('2 outgoing edges')
  })

  it('reports ambiguity between an unconditional and a matching exclusive edge', () => {
    const result = route({ a: 1 }, SOURCE, [
      edge('always', 'source', 'one', { mode: 'exclusive' }),
      edge('conditional', 'source', 'two', { mode: 'exclusive', condition: { op: 'eq', field: 'a', value: 1 } }),
    ])
    expect(result.failure?.code).toBe('routing/ambiguous')
    expect(result.failure?.candidates).toEqual(['always', 'conditional'])
  })

  it('keeps a fallback unused when one conditional exclusive edge matches', () => {
    const result = route({ score: 9 }, SOURCE, [
      edge('fallback', 'source', 'fallback', { mode: 'exclusive', fallback: true }),
      edge('high', 'source', 'high', { mode: 'exclusive', condition: { op: 'gt', field: 'score', value: 3 } }),
    ])
    expect(result.targets).toEqual(['high'])
  })

  it('activates every matching multiple edge in document order', () => {
    const result = route({ a: 1, b: 2 }, SOURCE, [
      edge('both', 'source', 'shared', { condition: { op: 'eq', field: 'a', value: 1 } }),
      edge('other', 'source', 'other', { condition: { op: 'eq', field: 'b', value: 2 } }),
      edge('never', 'source', 'never', { condition: { op: 'eq', field: 'b', value: 9 } }),
      edge('always', 'source', 'shared'),
    ])
    expect(result.targets).toEqual(['shared', 'other'])
    expect(result.edgeIds).toEqual(['both', 'other', 'always'])
    expect(result.failure).toBeNull()
  })

  it('counts each activated loop edge', () => {
    const result = route({}, SOURCE, [
      edge('again', 'source', 'source', { loop: { maxIterations: 3 } }),
      edge('next', 'source', 'next'),
    ])
    expect(result.targets).toEqual(['source', 'next'])
    expect(result.iterationDelta).toBe(1)
  })

  it('ignores edges that leave other nodes', () => {
    const result = route({}, SOURCE, [edge('other', 'elsewhere', 'target')])
    expect(result).toEqual({ targets: [], edgeIds: [], iterationDelta: 0, diagnostics: [], failure: null })
  })

  it('selects from an exclusive group and multiple edges together', () => {
    const result = route({ a: 1 }, SOURCE, [
      edge('choice', 'source', 'chosen', { mode: 'exclusive', condition: { op: 'eq', field: 'a', value: 1 } }),
      edge('always', 'source', 'extra'),
    ])
    expect(result.targets).toEqual(['chosen', 'extra'])
  })

  it('fails the whole decision when the exclusive group fails', () => {
    const result = route({ a: 2 }, SOURCE, [
      edge('choice', 'source', 'chosen', { mode: 'exclusive', condition: { op: 'eq', field: 'a', value: 1 } }),
      edge('always', 'source', 'extra'),
    ])
    expect(result.targets).toEqual([])
    expect(result.edgeIds).toEqual([])
    expect(result.failure?.code).toBe('routing/no-match')
  })

  it('attaches condition diagnostics to the edge that produced them', () => {
    const result = route({ score: 'high' }, SOURCE, [
      edge('numeric', 'source', 'target', { condition: { op: 'gt', field: 'score', value: 3 } }),
      edge('compared', 'source', 'target', { condition: { op: 'eq', field: 'missing', value: 3 } }),
    ])
    expect(result.diagnostics.map(diagnostic => [diagnostic.edgeId, diagnostic.code])).toEqual([
      ['numeric', 'predicate/type-mismatch'],
      ['compared', 'predicate/field-missing'],
    ])
  })

  it('treats a node without outgoing edges as an empty activation', () => {
    const result = route({}, SOURCE, [])
    expect(result.failure).toBeNull()
    expect(result.targets).toEqual([])
    expect(result.iterationDelta).toBe(0)
  })

  it('deduplicates targets while keeping one edge id per activation', () => {
    const result = route({}, SOURCE, [edge('one', 'source', 'same'), edge('two', 'source', 'same')])
    expect(result.targets).toEqual(['same'])
    expect(result.edgeIds).toEqual(['one', 'two'])
  })
})

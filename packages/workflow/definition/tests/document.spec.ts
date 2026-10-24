import { describe, expect, it } from 'vitest'
import { WORKFLOW_DEFINITION_VERSION, parseDefinitionDocument, serializeDefinition } from '../src/document.ts'
import { route } from '../src/route.ts'
import type { WorkflowDefinition } from '../src/types.ts'
import { validDefinition } from './support/definitions.ts'

describe('WORKFLOW_DEFINITION_VERSION', () => {
  it('is the only accepted document version', () => {
    expect(WORKFLOW_DEFINITION_VERSION).toBe(1)
  })
})

describe('serializeDefinition', () => {
  it('emits canonical JSON text', () => {
    const text = serializeDefinition(validDefinition())
    expect(text.startsWith('{"edges":[')).toBe(true)
    expect(text).not.toContain('\n')
  })

  it('emits identical text for equal definitions regardless of key order', () => {
    const first: WorkflowDefinition = {
      version: 1,
      nodes: [{ id: 'a', kind: 'python', title: 'A', config: { kind: 'python', source: 'def nodemain_a(' }, inputs: [], join: 'all' }],
      edges: [],
    }
    const second: WorkflowDefinition = {
      edges: [],
      nodes: [{ join: 'all', inputs: [], config: { source: 'def nodemain_a(', kind: 'python' }, title: 'A', kind: 'python', id: 'a' }],
      version: 1,
    }
    expect(serializeDefinition(first)).toBe(serializeDefinition(second))
  })
})

describe('parseDefinitionDocument', () => {
  it('round-trips a definition through text', () => {
    const definition = validDefinition()
    const parsed = parseDefinitionDocument(serializeDefinition(definition))
    expect(parsed).toEqual({ ok: true, definition })
  })

  it('preserves node and edge document order', () => {
    const definition = validDefinition()
    const parsed = parseDefinitionDocument(serializeDefinition(definition))
    if (!parsed.ok) throw new Error('expected a parsed definition')
    expect(parsed.definition.nodes.map(node => node.id)).toEqual(definition.nodes.map(node => node.id))
    expect(parsed.definition.edges.map(edge => edge.id)).toEqual(definition.edges.map(edge => edge.id))
  })

  it('keeps the parsed definition usable by the router', () => {
    const parsed = parseDefinitionDocument(serializeDefinition(validDefinition()))
    if (!parsed.ok) throw new Error('expected a parsed definition')
    const [fetch] = parsed.definition.nodes
    if (fetch === undefined) throw new Error('expected the entry node')
    const result = route({ ok: true }, fetch, parsed.definition.edges)
    expect(result.targets).toEqual(['gate'])
  })

  it('rejects YAML text without a YAML dependency', () => {
    const yaml = 'version: 1\nnodes: []\nedges: []\n'
    expect(parseDefinitionDocument(yaml)).toEqual({
      ok: false,
      violations: [{ code: 'definition/document-invalid-json', path: '', message: 'a definition document must be JSON text' }],
    })
  })

  it('rejects an empty document', () => {
    const result = parseDefinitionDocument('')
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.violations.map(violation => violation.code)).toEqual(['definition/document-invalid-json'])
  })

  it('rejects JSON that is not a definition object', () => {
    const result = parseDefinitionDocument('[1, 2, 3]')
    expect(result.ok ? [] : result.violations.map(violation => violation.code)).toEqual(['definition/document-invalid'])
  })

  it('returns every validation violation of a parsed document', () => {
    const result = parseDefinitionDocument(JSON.stringify({ version: 1, nodes: [{ id: 'Bad' }], edges: [] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.map(violation => violation.code)).toEqual([
      'definition/node-id-invalid',
      'definition/node-kind-invalid',
      'definition/node-title-empty',
      'definition/node-join-invalid',
      'definition/node-config-invalid',
      'definition/node-inputs-invalid',
      'definition/no-entry-node',
    ])
  })
})

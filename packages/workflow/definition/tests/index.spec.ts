import { describe, expect, it } from 'vitest'
import * as definition from '../src/index.ts'
import { validDefinition } from './support/definitions.ts'

describe('@metaworkflow/workflow-definition', () => {
  it('exposes the document round trip', () => {
    expect(definition.WORKFLOW_DEFINITION_VERSION).toBe(1)
    const text = definition.serializeDefinition(validDefinition())
    expect(definition.parseDefinitionDocument(text).ok).toBe(true)
  })

  it('exposes validation', () => {
    expect(definition.validateDefinition(validDefinition())).toEqual({ ok: true })
  })

  it('exposes routing and join arithmetic', () => {
    const parsed = definition.parseDefinitionDocument(definition.serializeDefinition(validDefinition()))
    if (!parsed.ok) throw new Error('expected a parsed definition')
    const [entry] = parsed.definition.nodes
    if (entry === undefined) throw new Error('expected an entry node')
    expect(definition.route({ ok: true }, entry, parsed.definition.edges).targets).toEqual(['gate'])
    expect(definition.computeJoin('all', ['a'], ['a']).fire).toBe(true)
    expect(definition.JOIN_NOT_FIRED).toEqual({ fired: false })
  })

  it('exposes predicate evaluation and field paths', () => {
    expect(definition.evaluatePredicate({ review: { passed: true } }, { op: 'eq', field: 'review.passed', value: true }).matched).toBe(true)
    expect(definition.parseFieldPath('review.passed')).toEqual(['review', 'passed'])
    expect(definition.readFieldPath({ review: { passed: true } }, ['review', 'passed'])).toBe(true)
  })

  it('exposes the JSON helpers', () => {
    expect(definition.isJsonObject({})).toBe(true)
    expect(definition.isJsonScalar(1)).toBe(true)
    expect(definition.jsonValueCategory([])).toBe('array')
    expect(definition.canonicalJson({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 })
  })
})

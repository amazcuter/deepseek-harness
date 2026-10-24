import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@metaworkflow/util-values'
import type { Predicate, PredicateDiagnostic } from '../src/types.ts'
import { evaluatePredicate } from '../src/predicate.ts'

/** One predicate case: a result, a condition, and the expected outcome. */
interface PredicateCase {
  /** Case name, shown by the runner. */
  readonly name: string
  /** The node result the predicate reads. */
  readonly result: JsonValue
  /** The condition under test. */
  readonly predicate: Predicate
  /** Expected match result. */
  readonly matched: boolean
  /** Expected diagnostic codes, in evaluation order. */
  readonly diagnostics?: readonly PredicateDiagnostic['code'][]
}

const CASES: readonly PredicateCase[] = [
  { name: 'exists finds a present field', result: { value: 0 }, predicate: { op: 'exists', field: 'value' }, matched: true },
  { name: 'exists rejects a missing field', result: { value: 0 }, predicate: { op: 'exists', field: 'other' }, matched: false },
  { name: 'exists reads a nested path', result: { deep: { value: null } }, predicate: { op: 'exists', field: 'deep.value' }, matched: true },
  { name: 'exists rejects a path through a scalar', result: { value: 1 }, predicate: { op: 'exists', field: 'value.inner' }, matched: false },
  { name: 'truthy accepts a non-empty string', result: { value: 'x' }, predicate: { op: 'truthy', field: 'value' }, matched: true },
  { name: 'truthy rejects an empty string', result: { value: '' }, predicate: { op: 'truthy', field: 'value' }, matched: false },
  { name: 'truthy rejects zero', result: { value: 0 }, predicate: { op: 'truthy', field: 'value' }, matched: false },
  { name: 'truthy rejects null', result: { value: null }, predicate: { op: 'truthy', field: 'value' }, matched: false },
  { name: 'truthy rejects false', result: { value: false }, predicate: { op: 'truthy', field: 'value' }, matched: false },
  { name: 'truthy accepts an object', result: { value: {} }, predicate: { op: 'truthy', field: 'value' }, matched: true },
  { name: 'truthy rejects a missing field', result: {}, predicate: { op: 'truthy', field: 'value' }, matched: false },
  { name: 'eq matches a number', result: { value: 2 }, predicate: { op: 'eq', field: 'value', value: 2 }, matched: true },
  { name: 'eq rejects a different number', result: { value: 2 }, predicate: { op: 'eq', field: 'value', value: 3 }, matched: false },
  { name: 'eq matches a string', result: { value: 'ok' }, predicate: { op: 'eq', field: 'value', value: 'ok' }, matched: true },
  { name: 'eq matches null', result: { value: null }, predicate: { op: 'eq', field: 'value', value: null }, matched: true },
  { name: 'eq matches a boolean', result: { value: true }, predicate: { op: 'eq', field: 'value', value: true }, matched: true },
  {
    name: 'eq rejects a number against a string operand',
    result: { value: 1 },
    predicate: { op: 'eq', field: 'value', value: '1' },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'eq rejects an object operand',
    result: { value: { a: 1 } },
    predicate: { op: 'eq', field: 'value', value: { a: 1 } },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'eq rejects a missing field',
    result: {},
    predicate: { op: 'eq', field: 'value', value: 1 },
    matched: false,
    diagnostics: ['predicate/field-missing'],
  },
  {
    name: 'eq rejects a missing operand',
    result: { value: 1 },
    predicate: { op: 'eq', field: 'value' },
    matched: false,
    diagnostics: ['predicate/value-missing'],
  },
  {
    name: 'eq does not match NaN',
    result: { value: Number.NaN },
    predicate: { op: 'eq', field: 'value', value: 1 },
    matched: false,
  },
  { name: 'ne matches a different value', result: { value: 1 }, predicate: { op: 'ne', field: 'value', value: 2 }, matched: true },
  { name: 'ne rejects an equal value', result: { value: 1 }, predicate: { op: 'ne', field: 'value', value: 1 }, matched: false },
  {
    name: 'ne rejects a type mismatch',
    result: { value: 1 },
    predicate: { op: 'ne', field: 'value', value: '1' },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  { name: 'gt matches a larger field', result: { value: 3 }, predicate: { op: 'gt', field: 'value', value: 2 }, matched: true },
  { name: 'gt rejects an equal field', result: { value: 2 }, predicate: { op: 'gt', field: 'value', value: 2 }, matched: false },
  { name: 'gte matches an equal field', result: { value: 2 }, predicate: { op: 'gte', field: 'value', value: 2 }, matched: true },
  { name: 'lt matches a smaller field', result: { value: 1 }, predicate: { op: 'lt', field: 'value', value: 2 }, matched: true },
  { name: 'lte matches an equal field', result: { value: 2 }, predicate: { op: 'lte', field: 'value', value: 2 }, matched: true },
  {
    name: 'gt rejects a string field',
    result: { value: '3' },
    predicate: { op: 'gt', field: 'value', value: 2 },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'gt rejects a string operand',
    result: { value: 3 },
    predicate: { op: 'gt', field: 'value', value: '2' },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'gt does not match NaN',
    result: { value: Number.NaN },
    predicate: { op: 'gt', field: 'value', value: 0 },
    matched: false,
  },
  { name: 'in matches one element', result: { value: 'b' }, predicate: { op: 'in', field: 'value', value: ['a', 'b'] }, matched: true },
  { name: 'in rejects an absent element', result: { value: 'c' }, predicate: { op: 'in', field: 'value', value: ['a', 'b'] }, matched: false },
  {
    name: 'in rejects an operand array of other types',
    result: { value: 1 },
    predicate: { op: 'in', field: 'value', value: ['a'] },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'in rejects a non-array operand',
    result: { value: 1 },
    predicate: { op: 'in', field: 'value', value: 'a' },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  { name: 'not-in matches an absent element', result: { value: 'c' }, predicate: { op: 'not-in', field: 'value', value: ['a', 'b'] }, matched: true },
  { name: 'not-in rejects a present element', result: { value: 'a' }, predicate: { op: 'not-in', field: 'value', value: ['a', 'b'] }, matched: false },
  {
    name: 'not-in rejects an incomparable array',
    result: { value: 1 },
    predicate: { op: 'not-in', field: 'value', value: ['a'] },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'in rejects an object field',
    result: { value: { a: 1 } },
    predicate: { op: 'in', field: 'value', value: [{ a: 1 }] },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  { name: 'in reads an array element', result: { items: [{ name: 'x' }] }, predicate: { op: 'eq', field: 'items.0.name', value: 'x' }, matched: true },
  {
    name: 'an invalid path reports a type mismatch',
    result: { value: 1 },
    predicate: { op: 'exists', field: 'value..inner' },
    matched: false,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'and requires every argument',
    result: { a: 1, b: 2 },
    predicate: { op: 'and', args: [{ op: 'eq', field: 'a', value: 1 }, { op: 'eq', field: 'b', value: 3 }] },
    matched: false,
  },
  {
    name: 'and matches every argument',
    result: { a: 1, b: 2 },
    predicate: { op: 'and', args: [{ op: 'eq', field: 'a', value: 1 }, { op: 'eq', field: 'b', value: 2 }] },
    matched: true,
  },
  {
    name: 'or needs one argument',
    result: { a: 1, b: 2 },
    predicate: { op: 'or', args: [{ op: 'eq', field: 'a', value: 9 }, { op: 'eq', field: 'b', value: 2 }] },
    matched: true,
  },
  {
    name: 'or rejects every argument',
    result: { a: 1, b: 2 },
    predicate: { op: 'or', args: [{ op: 'eq', field: 'a', value: 9 }, { op: 'eq', field: 'b', value: 8 }] },
    matched: false,
  },
  { name: 'an empty and matches', result: {}, predicate: { op: 'and', args: [] }, matched: true },
  { name: 'an empty or rejects', result: {}, predicate: { op: 'or', args: [] }, matched: false },
  {
    name: 'not negates a match',
    result: { a: 1 },
    predicate: { op: 'not', arg: { op: 'eq', field: 'a', value: 1 } },
    matched: false,
  },
  {
    name: 'not negates a rejection',
    result: { a: 1 },
    predicate: { op: 'not', arg: { op: 'eq', field: 'a', value: 2 } },
    matched: true,
  },
  {
    name: 'and reports every argument diagnostic',
    result: {},
    predicate: {
      op: 'and',
      args: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'gt', field: 'b', value: 1 },
      ],
    },
    matched: false,
    diagnostics: ['predicate/field-missing', 'predicate/field-missing'],
  },
  {
    name: 'or reports diagnostics from arguments that did not decide the result',
    result: { a: 1 },
    predicate: {
      op: 'or',
      args: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'gt', field: 'a', value: 'x' },
      ],
    },
    matched: true,
    diagnostics: ['predicate/type-mismatch'],
  },
  {
    name: 'ignores a control field named next',
    result: { next: 'report', value: 1 },
    predicate: { op: 'eq', field: 'next', value: 'report' },
    matched: true,
  },
]

describe('evaluatePredicate', () => {
  it.each([...CASES])('$name', ({ result, predicate, matched, diagnostics }) => {
    const evaluation = evaluatePredicate(result, predicate)
    expect(evaluation.matched).toBe(matched)
    expect(evaluation.diagnostics.map(diagnostic => diagnostic.code)).toEqual([...(diagnostics ?? [])])
    for (const diagnostic of evaluation.diagnostics) expect(diagnostic.message.length).toBeGreaterThan(0)
  })

  it('reads fields without touching inherited properties', () => {
    expect(evaluatePredicate({}, { op: 'exists', field: 'constructor' }).matched).toBe(false)
    expect(evaluatePredicate({}, { op: 'exists', field: '__proto__' }).matched).toBe(false)
    expect(evaluatePredicate({ nested: { deep: 1 } }, { op: 'exists', field: 'nested.constructor' }).matched).toBe(false)
  })

  it('treats a sparse array hole as a missing field', () => {
    const sparse: JsonValue[] = [1]
    sparse.length = 3
    expect(evaluatePredicate(sparse, { op: 'exists', field: '1' }).matched).toBe(false)
  })

  it('reports the field path of a diagnostic', () => {
    const evaluation = evaluatePredicate({}, { op: 'eq', field: 'review.passed', value: true })
    expect(evaluation.diagnostics).toEqual([
      { code: 'predicate/field-missing', field: 'review.passed', message: 'eq comparison on "review.passed" found no field value' },
    ])
  })
})

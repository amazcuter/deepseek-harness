import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@metaworkflow/util-values'
import { canonicalJson, isJsonObject, isJsonScalar, jsonValueCategory, type JsonValueCategory } from '../src/json.ts'

/** Category cases: one JSON value and the category it must report. */
const CATEGORY_CASES: readonly (readonly [JsonValue, JsonValueCategory])[] = [
  [null, 'null'],
  [true, 'boolean'],
  [1, 'number'],
  ['text', 'string'],
  [[], 'array'],
  [{}, 'object'],
]

describe('isJsonObject', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [null, false],
    [[], false],
    ['text', false],
    [1, false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isJsonObject(value)).toBe(expected)
  })
})

describe('isJsonScalar', () => {
  it.each([
    [null, true],
    [true, true],
    [0, true],
    ['text', true],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [[], false],
    [{}, false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isJsonScalar(value)).toBe(expected)
  })
})

describe('jsonValueCategory', () => {
  it.each([...CATEGORY_CASES])('classifies %j as %s', (value, expected) => {
    expect(jsonValueCategory(value)).toBe(expected)
  })
})

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    const input = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }
    expect(JSON.stringify(canonicalJson(input))).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toEqual([3, 1, 2])
  })

  it('returns scalars unchanged', () => {
    expect([canonicalJson(null), canonicalJson(true), canonicalJson(5), canonicalJson('x')]).toEqual([null, true, 5, 'x'])
  })

  it('does not mutate its input', () => {
    const input = { b: 1, a: 2 }
    canonicalJson(input)
    expect(Object.keys(input)).toEqual(['b', 'a'])
  })
})

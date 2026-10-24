import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@metaworkflow/util-values'
import { parseFieldPath, readFieldPath } from '../src/path.ts'

describe('parseFieldPath', () => {
  it.each([
    ['value', ['value']],
    ['review.passed', ['review', 'passed']],
    ['items.0.name', ['items', '0', 'name']],
    ['_private.$field', ['_private', '$field']],
    ['1st', undefined],
    ['0', ['0']],
    ['01', undefined],
    ['', undefined],
    ['a..b', undefined],
    ['.a', undefined],
    ['a.', undefined],
    ['a-b', undefined],
    ['a b', undefined],
  ])('parses %s', (path, expected) => {
    expect(parseFieldPath(path)).toEqual(expected)
  })
})

/** A JSON object whose `hole` property holds a runtime `undefined`. */
function objectWithUndefinedMember(): JsonValue {
  const value: Record<string, JsonValue> = { other: 1 }
  Object.defineProperty(value, 'hole', { value: undefined, enumerable: true })
  return value
}

/** A JSON array with a trailing hole. */
function sparseArray(): JsonValue {
  const value: JsonValue[] = ['first']
  value.length = 3
  return value
}

describe('readFieldPath', () => {
  it('returns the root when no segments are given', () => {
    expect(readFieldPath({ a: 1 }, [])).toEqual({ a: 1 })
  })

  it('reads nested object properties', () => {
    expect(readFieldPath({ review: { passed: true } }, ['review', 'passed'])).toBe(true)
  })

  it('reads array elements by index', () => {
    expect(readFieldPath({ items: [{ name: 'x' }] }, ['items', '0', 'name'])).toBe('x')
  })

  it('reads a null leaf as present', () => {
    expect(readFieldPath({ value: null }, ['value'])).toBeNull()
  })

  it.each([
    ['a missing key', { value: 1 }, ['other']],
    ['a missing nested key', { value: {} }, ['value', 'other']],
    ['a path through a string', { value: 'text' }, ['value', 'length']],
    ['a path through a number', { value: 1 }, ['value', 'other']],
    ['a path through null', { value: null }, ['value', 'other']],
    ['a path through a boolean', { value: true }, ['value', 'other']],
    ['an array index past the end', { items: [1] }, ['items', '1']],
    ['a non-numeric array index', { items: [1] }, ['items', 'first']],
    ['a negative array index', { items: [1] }, ['items', '-1']],
  ])('returns undefined for %s', (_name, value, segments) => {
    expect(readFieldPath(value, segments)).toBeUndefined()
  })

  it('treats a sparse array hole as absent', () => {
    expect(readFieldPath(sparseArray(), ['1'])).toBeUndefined()
  })

  it('treats an undefined object member as absent', () => {
    expect(readFieldPath(objectWithUndefinedMember(), ['hole'])).toBeUndefined()
  })

  it('does not read inherited properties', () => {
    expect(readFieldPath({}, ['constructor'])).toBeUndefined()
    expect(readFieldPath({}, ['__proto__'])).toBeUndefined()
    expect(readFieldPath({}, ['toString'])).toBeUndefined()
  })
})

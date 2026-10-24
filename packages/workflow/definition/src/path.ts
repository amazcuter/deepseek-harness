/**
 * Dot-separated field paths over JSON results. Paths are data, never
 * expressions: a path addresses object properties and array indices only.
 *
 * @module @metaworkflow/workflow-definition/path
 */

import type { JsonValue } from '@metaworkflow/util-values'

/** One accepted segment: an identifier, or a canonical non-negative index. */
const SEGMENT_PATTERN = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|0|[1-9]\d*)$/

/**
 * Split a field path into segments, or reject it.
 * @param path - candidate dot-separated path such as `review.passed` or `items.0.name`.
 * @returns the segments, or `undefined` when the path is empty or has an invalid segment.
 */
export function parseFieldPath(path: string): readonly string[] | undefined {
  if (path.length === 0) return undefined
  const segments = path.split('.')
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) return undefined
  }
  return segments
}

/**
 * Read one field path out of a JSON value.
 * @param value - the JSON value to read from.
 * @param segments - parsed path segments, as returned by {@link parseFieldPath}.
 * @returns the addressed value, or `undefined` when any segment is absent.
 */
export function readFieldPath(value: JsonValue, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue = value
  for (const segment of segments) {
    if (!Array.isArray(current) && (typeof current !== 'object' || current === null)) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      const next: JsonValue | undefined = current[index]
      if (next === undefined) return undefined
      current = next
      continue
    }
    const object: { readonly [key: string]: JsonValue } = current
    if (!Object.hasOwn(object, segment)) return undefined
    const next: JsonValue | undefined = object[segment]
    if (next === undefined) return undefined
    current = next
  }
  return current
}

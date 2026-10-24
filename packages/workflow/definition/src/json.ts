/**
 * JSON narrowing and canonicalization helpers shared by the definition
 * document layer and the validator. Values arrive from stored text as
 * `unknown`, so every helper narrows instead of asserting.
 *
 * @module @metaworkflow/workflow-definition/json
 */

import type { JsonValue } from '@metaworkflow/util-values'

/** The comparison category of one JSON value. */
export type JsonValueCategory = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'

/**
 * Whether a value is a non-array JSON object.
 * @param value - candidate value of unknown origin.
 * @returns true for a plain object, never for `null` or an array.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a JSON scalar.
 * @param value - candidate value of unknown origin.
 * @returns true for `null`, a boolean, a finite number, or a string.
 */
export function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Classify one JSON value for strict comparison.
 * @param value - the JSON value to classify.
 * @returns its category; arrays and objects are distinct from `null`.
 */
export function jsonValueCategory(value: JsonValue): JsonValueCategory {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return 'number'
    case 'string': return 'string'
    default: return 'object'
  }
}

/**
 * Copy a JSON-compatible value with every object's keys sorted, so two equal
 * documents produce identical text.
 * @param value - value of unknown origin; `undefined` members are dropped by
 * the caller's `JSON.stringify`.
 * @returns a copy with sorted object keys and array order preserved.
 */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalJson(item))
  if (!isJsonObject(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key])
  return sorted
}

/**
 * Predicate evaluation over a node result. Conditions read business fields of
 * the result JSON and never evaluate expressions, coerce types, or consult
 * control fields such as `next`; every incomparable case evaluates `false` and
 * records a diagnostic.
 *
 * @module @metaworkflow/workflow-definition/predicate
 */

import type { JsonValue } from '@metaworkflow/util-values'
import { isJsonScalar, jsonValueCategory } from './json.ts'
import { parseFieldPath, readFieldPath } from './path.ts'
import type { FieldPredicate, Predicate, PredicateDiagnostic, PredicateEvaluation } from './types.ts'

/** Ordered numeric comparison operators. */
type OrderedOp = 'gt' | 'gte' | 'lt' | 'lte'

/** Equality operators. */
type EqualityOp = 'eq' | 'ne'

/** Membership operators. */
type MembershipOp = 'in' | 'not-in'

/**
 * Evaluate one predicate against a node result.
 * @param result - the node's JSON result; only data fields are read.
 * @param predicate - the edge condition to evaluate.
 * @returns whether the predicate matched, plus diagnostics for every incomparable comparison.
 */
export function evaluatePredicate(result: JsonValue, predicate: Predicate): PredicateEvaluation {
  const diagnostics: PredicateDiagnostic[] = []
  const matched = evaluateNode(result, predicate, diagnostics)
  return { matched, diagnostics }
}

/**
 * Evaluate one predicate node, appending diagnostics.
 * @param result - the node result being inspected.
 * @param predicate - current predicate node.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @returns whether this predicate node matched.
 */
function evaluateNode(result: JsonValue, predicate: Predicate, diagnostics: PredicateDiagnostic[]): boolean {
  switch (predicate.op) {
    case 'and':
      return evaluateArguments(result, predicate.args, diagnostics, true)
    case 'or':
      return evaluateArguments(result, predicate.args, diagnostics, false)
    case 'not':
      return !evaluateNode(result, predicate.arg, diagnostics)
    default:
      return evaluateField(result, predicate, diagnostics)
  }
}

/**
 * Combine nested predicate results. Arguments are never short-circuited, so the
 * reported diagnostics describe the whole condition.
 * @param result - the node result being inspected.
 * @param args - nested predicates in document order.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @param initial - `true` for `and`, `false` for `or`.
 * @returns the combined match result.
 */
function evaluateArguments(
  result: JsonValue,
  args: readonly Predicate[],
  diagnostics: PredicateDiagnostic[],
  initial: boolean,
): boolean {
  let matched = initial
  for (const arg of args) {
    const argMatched = evaluateNode(result, arg, diagnostics)
    matched = initial ? matched && argMatched : matched || argMatched
  }
  return matched
}

/**
 * Apply one field comparison.
 * @param result - the node result being inspected.
 * @param predicate - the field comparison to apply.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @returns whether the comparison matched.
 */
function evaluateField(result: JsonValue, predicate: FieldPredicate, diagnostics: PredicateDiagnostic[]): boolean {
  const segments = parseFieldPath(predicate.field)
  if (segments === undefined) {
    diagnostics.push({
      code: 'predicate/type-mismatch',
      field: predicate.field,
      message: `field path ${JSON.stringify(predicate.field)} is not a dot-separated path`,
    })
    return false
  }
  const value = readFieldPath(result, segments)
  if (predicate.op === 'exists') return value !== undefined
  if (predicate.op === 'truthy') return value !== undefined && Boolean(value)
  const operand = predicate.value
  if (operand === undefined) {
    diagnostics.push({
      code: 'predicate/value-missing',
      field: predicate.field,
      message: `${predicate.op} comparison on ${JSON.stringify(predicate.field)} has no operand`,
    })
    return false
  }
  if (value === undefined) {
    diagnostics.push({
      code: 'predicate/field-missing',
      field: predicate.field,
      message: `${predicate.op} comparison on ${JSON.stringify(predicate.field)} found no field value`,
    })
    return false
  }
  if (predicate.op === 'in' || predicate.op === 'not-in') {
    return evaluateMembership(predicate.op, predicate.field, value, operand, diagnostics)
  }
  if (predicate.op === 'eq' || predicate.op === 'ne') {
    return evaluateEquality(predicate.op, predicate.field, value, operand, diagnostics)
  }
  return evaluateOrdered(predicate.op, predicate.field, value, operand, diagnostics)
}

/**
 * Apply an equality comparison. Types are strict: a category mismatch never matches.
 * @param op - `eq` or `ne`.
 * @param field - the field path involved, for diagnostics.
 * @param value - the present field value.
 * @param operand - the declared operand.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @returns whether the comparison matched.
 */
function evaluateEquality(
  op: EqualityOp,
  field: string,
  value: JsonValue,
  operand: JsonValue,
  diagnostics: PredicateDiagnostic[],
): boolean {
  if (!isJsonScalar(operand) || jsonValueCategory(value) !== jsonValueCategory(operand)) {
    diagnostics.push(typeMismatch(field, `${op} compares ${jsonValueCategory(value)} with ${jsonValueCategory(operand)}`))
    return false
  }
  const equal = value === operand
  return op === 'eq' ? equal : !equal
}

/**
 * Apply an ordered numeric comparison. Non-numbers never match.
 * @param op - the ordered comparison operator.
 * @param field - the field path involved, for diagnostics.
 * @param value - the present field value.
 * @param operand - the declared operand.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @returns whether the comparison holds; `NaN` satisfies no ordered comparison.
 */
function evaluateOrdered(
  op: OrderedOp,
  field: string,
  value: JsonValue,
  operand: JsonValue,
  diagnostics: PredicateDiagnostic[],
): boolean {
  if (typeof value !== 'number' || typeof operand !== 'number') {
    diagnostics.push(typeMismatch(field, `${op} requires numbers, got ${jsonValueCategory(value)} and ${jsonValueCategory(operand)}`))
    return false
  }
  switch (op) {
    case 'gt': return value > operand
    case 'gte': return value >= operand
    case 'lt': return value < operand
    case 'lte': return value <= operand
  }
}

/**
 * Apply a membership test. Elements compare strictly; an operand array with no
 * element of the field's type never matches.
 * @param op - `in` or `not-in`.
 * @param field - the field path involved, for diagnostics.
 * @param value - the present field value.
 * @param operand - the declared operand.
 * @param diagnostics - accumulator for observed incomparabilities.
 * @returns whether the membership test matched.
 */
function evaluateMembership(
  op: MembershipOp,
  field: string,
  value: JsonValue,
  operand: JsonValue,
  diagnostics: PredicateDiagnostic[],
): boolean {
  if (!Array.isArray(operand)) {
    diagnostics.push(typeMismatch(field, `${op} requires an array operand, got ${jsonValueCategory(operand)}`))
    return false
  }
  const category = jsonValueCategory(value)
  if (!operand.some(item => isJsonScalar(item) && jsonValueCategory(item) === category)) {
    diagnostics.push(typeMismatch(field, `no ${op} operand element has the field type ${category}`))
    return false
  }
  const found = operand.some(item => item === value)
  return op === 'in' ? found : !found
}

/**
 * Record a type incompatibility.
 * @param field - the field path involved.
 * @param detail - the concrete incompatibility.
 * @returns the diagnostic to report; the caller reports a non-match.
 */
function typeMismatch(field: string, detail: string): PredicateDiagnostic {
  return { code: 'predicate/type-mismatch', field, message: detail }
}

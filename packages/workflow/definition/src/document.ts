/**
 * The stored document form of a workflow definition. Definitions travel as
 * JSON text — never YAML or evaluated expressions — so `serializeDefinition`
 * emits canonical key-sorted JSON and `parseDefinitionDocument` accepts JSON
 * text only and validates it before returning a typed document.
 *
 * @module @metaworkflow/workflow-definition/document
 */

import { canonicalJson } from './json.ts'
import type { DefinitionParseResult, WorkflowDefinition } from './types.ts'
import { validateDefinition } from './validate.ts'

/** The only accepted definition document version. */
export const WORKFLOW_DEFINITION_VERSION = 1

/**
 * Serialize one definition as canonical JSON text.
 *
 * Object keys are emitted in sorted order, so two equal definitions always
 * produce identical text; array order (node and edge document order) is
 * preserved. Callers must pass a definition that already passed
 * {@link validateDefinition}: non-finite numbers would degrade to `null` in the
 * text.
 *
 * @param definition - the definition to serialize.
 * @returns the JSON document text.
 */
export function serializeDefinition(definition: WorkflowDefinition): string {
  return JSON.stringify(canonicalJson(definition))
}

/**
 * Parse one stored definition document.
 *
 * Only JSON text is accepted; YAML and any other syntax is rejected with
 * `definition/document-invalid-json`. A parsed document then runs the full
 * validation rule set, so a returned definition is known to be executable.
 *
 * @param text - the stored document text.
 * @returns the typed definition, or the violations that reject the document.
 */
export function parseDefinitionDocument(text: string): DefinitionParseResult {
  const parsed = parseJson(text)
  if (!parsed.ok) {
    return {
      ok: false,
      violations: [{
        code: 'definition/document-invalid-json',
        path: '',
        message: 'a definition document must be JSON text',
      }],
    }
  }
  const validation = validateDefinition(parsed.value)
  if (!validation.ok) return { ok: false, violations: validation.violations }
  // validateDefinition proved the document satisfies WorkflowDefinition.
  const definition = parsed.value as WorkflowDefinition
  return { ok: true, definition }
}

/** One JSON parse attempt. */
type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

/**
 * Parse JSON text without throwing.
 * @param text - candidate document text.
 * @returns the parsed value, or `{ ok: false }` when the text is not JSON.
 */
function parseJson(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch {
    // JSON.parse is the only operation in the try; its SyntaxError is the whole answer.
    return { ok: false }
  }
}

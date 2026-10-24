/**
 * The built-in novel-writing template: the example definition the dashboard's
 * **Use the novel template** action stores into a new project.
 *
 * `novel.json` is the authored artifact because the frozen document text is
 * exactly what `projects.importDefinition` accepts. The Host parses and
 * validates it before it stores a revision, so a template that no longer
 * satisfies the definition rules is refused there; `tests/novel-template.client.spec.ts`
 * asserts the shipped document against the same validator.
 *
 * The graph is `prepare` → `draft` → parallel `review-style`/`review-consistency`
 * → `gate`, which publishes on a pass and loops back to `draft` at most three
 * times. The reviews are separate nodes so the two agent nodes can carry
 * different tool selections, and the gate is Python so the aggregate rule is
 * code the user can edit rather than a condition on the canvas.
 */
import definition from './novel.json'

/**
 * The template's definition document text, ready for `projects.importDefinition`.
 *
 * Serialized here rather than shipped as raw text so the import receives valid
 * JSON even if the file is edited.
 */
export const NOVEL_TEMPLATE_DOCUMENT: string = JSON.stringify(definition)

/**
 * The completion tool every agent node receives: the one model-facing way to
 * report the node's structured result.
 *
 * The node's `outputSchema` becomes the tool's `value` parameter, so a
 * submission that does not satisfy the stored schema is an ordinary
 * `ToolArgsError` the model can correct in the same turn; a valid submission is
 * recorded only after the authoritative `tools/result` succeeds, and a
 * monotonic guard makes every later call a no-op. A plain assistant message is
 * never a completion.
 *
 * @module @metaworkflow/workflow-agent-executor/completion
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@metaworkflow/util-values'
import type { ToolExecution, ToolRunContext } from '@metaworkflow/tools'
import {
  ToolArgsError,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
} from '@metaworkflow/tools'
import type { JsonSchemaNode } from '@metaworkflow/tools'

/** Model-facing name of the tool an agent node must call to finish. */
export const COMPLETION_TOOL_NAME = 'submit_node_result'

/** The instruction registered as the child's trailing scoped prompt section. */
export const COMPLETION_INSTRUCTION
  = 'When the node\'s work is complete, you MUST report its result by calling the '
    + `\`${COMPLETION_TOOL_NAME}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only that tool call counts as the node result.'

/** Inputs the completion tool needs from the executing attempt. */
export interface CompletionOptions {
  /** The node's stored output schema; the tool's `value` parameter validates against it. */
  readonly schema: JsonSchemaNode
  /**
   * Record one accepted value for this attempt. Called at most once, after the
   * value's own `tools/result` succeeded, so a later pipeline failure cannot
   * leave a completion behind.
   * @param value - the validated node result.
   */
  record(value: JsonValue): void
}

/** The parameter schema the model sees and the executor enforces. */
function completionParameters(schema: JsonSchemaNode): ObjectJsonSchema {
  return {
    type: 'object',
    properties: { value: schema },
    required: ['value'],
    additionalProperties: false,
  }
}

/**
 * Attach the completion tool, its prompt section, its terminal guard, and the
 * two-phase capture to one unpublished child Agent.
 *
 * Every registration belongs to the child's scope, so disposing the child
 * removes it and two concurrent nodes never see each other's tool.
 * @param childCtx - the child Agent's scope context, during its creation window.
 * @param options - the node's stored output schema and the attempt's sink.
 * @returns nothing; the sink receives the value once the accepted call settles.
 */
export function attachCompletionTool(childCtx: Context, options: CompletionOptions): void {
  const parameters = completionParameters(options.schema)
  /**
   * Values staged by the tool body, awaiting their own authoritative
   * `tools/result`. The execution identity is the key, because adapter call ids
   * may repeat across steps while another execution never reaches this entry.
   */
  const staged = new Map<ToolExecution, { readonly value: JsonValue }>()
  /** Successful nested call waiting for its enclosing transport to commit. */
  let pending: { readonly parent: ToolExecution['token']; readonly value: JsonValue } | undefined
  let recorded: { readonly value: JsonValue } | undefined

  childCtx.tools.register({
    name: COMPLETION_TOOL_NAME,
    description:
      'Report this workflow node\'s result. Call this exactly once, when the node\'s work is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: { ...parameters },
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Node result recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(parameters, args)
      // ToolArgsError becomes an isError result: the model corrects the value
      // inside the same turn instead of the attempt failing.
      if (violations.length > 0) throw new ToolArgsError(violations)
      // The arguments passed the parameter schema above, whose sole required
      // property is `value`, and the registry froze them as lossless JSON.
      staged.set(exec, { value: (args as { readonly value: JsonValue }).value })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${COMPLETION_TOOL_NAME}`,
    order: childCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: COMPLETION_INSTRUCTION,
  })

  // Terminal within the step: guards run after every pre-execute policy and
  // compose monotonically, so a later listener cannot reopen a completed node.
  const complete = (): boolean => recorded !== undefined || pending !== undefined
  childCtx.tools.guard(exec => complete()
    ? `the node result was already recorded, so \`${exec.name}\` is not executed`
    : undefined)

  childCtx.on('tools/result', (exec, result) => {
    if (exec.name !== COMPLETION_TOOL_NAME) return
    const entry = staged.get(exec)
    if (entry !== undefined) {
      staged.delete(exec)
      if (result.isError) return
      /* v8 ignore else -- a PTC presentation dispatches this tool with a parent execution; native calls have none */
      if (exec.parent === undefined) {
        /* v8 ignore else -- the monotonic guard blocks every later supported call, so a second commit cannot occur */
        if (recorded === undefined) {
          recorded = entry
          options.record(entry.value)
        }
      } else {
        pending ??= { parent: exec.parent, value: entry.value }
      }
      return
    }
    /* v8 ignore start -- the nested-commit branch belongs to a PTC presentation that unit suites do not compose */
    if (pending?.parent !== exec.token) return
    const settled = pending
    pending = undefined
    if (result.isError) return
    if (recorded === undefined) {
      recorded = { value: settled.value }
      options.record(settled.value)
    }
    /* v8 ignore stop */
  })
}

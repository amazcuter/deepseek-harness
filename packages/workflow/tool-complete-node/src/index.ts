/**
 * The completion tool every workflow agent node receives: the one model-facing
 * way for a node to report its structured result.
 *
 * The node's `outputSchema` becomes the tool's `value` parameter, so a
 * submission that does not satisfy the stored schema is an ordinary
 * `ToolArgsError` the model can correct inside the same turn; a valid
 * submission is recorded only after the authoritative `tools/result` succeeds,
 * and a monotonic guard makes every later call unable to replace or extend that
 * result. A plain assistant message is never a completion.
 *
 * The parameter schema is the node's stored JSON Schema verbatim, so the tool
 * is registered as a raw `ToolDefinition` rather than through `defineTool`,
 * whose parameter DSL cannot carry an arbitrary stored schema.
 *
 * @module @metaworkflow/tool-complete-node
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, validateJsonSchemaValue } from '@metaworkflow/tools'
import type { JsonSchemaNode, ObjectJsonSchema, ToolExecution, ToolRunContext } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'
// Type-only: brings `ctx.systemPrompt` and the `tools/result` event into the owner context type.
import type {} from '@metaworkflow/system-prompt'
import type { CompleteNodeResultMeta, CompleteNodeTool, CompleteNodeToolOptions } from './types.ts'

export type { CompleteNodeResultMeta, CompleteNodeTool, CompleteNodeToolOptions } from './types.ts'

/** Model-facing name the completion tool registers under when options omit one. */
export const COMPLETION_TOOL_NAME = 'submit_node_result'

/** Model-facing description the completion tool registers when options omit one. */
export const COMPLETION_TOOL_DESCRIPTION
  = 'Submit this workflow node\'s structured result. Call it exactly once, when the node\'s work is complete; '
    + 'a plain text answer is not a completion, and the arguments must match this tool\'s parameter schema exactly.'

/** Card header the accepted submission's presentation metadata carries. */
const RESULT_TITLE = 'Node result'

/** Summary of a call whose arguments carry no submitted value, such as a replayed malformed call. */
const NO_VALUE_SUMMARY = 'no structured value submitted'

/** Longest summary the presentation metadata keeps, in characters. */
const SUMMARY_LIMIT = 200

/** Text the tool's result renders with once a submission is accepted. */
const RECORDED_TEXT = 'Node result recorded.'

/**
 * The trailing instruction naming the tool a node must call to finish.
 * @param toolName - model-facing name of the completion tool in this scope.
 * @returns the instruction text, naming that tool verbatim.
 */
export function completionInstruction(toolName: string): string {
  return 'When the node\'s work is complete, you MUST report its result by calling the '
    + `\`${toolName}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only that tool call counts as the node result.'
}

/** The instruction registered for the package's default tool name. */
export const COMPLETION_INSTRUCTION = completionInstruction(COMPLETION_TOOL_NAME)

/** The parameter schema the model sees and the executor enforces. */
function completionParameters(outputSchema: JsonSchemaNode): ObjectJsonSchema {
  return {
    type: 'object',
    properties: { value: outputSchema },
    required: ['value'],
    additionalProperties: false,
  }
}

/**
 * One-line JSON text of a submitted value, bounded so a large node result
 * cannot bloat the session log's presentation metadata.
 * @param value - the submitted value, or `undefined` for a call that carries none.
 * @returns the summary text.
 */
function summarize(value: JsonValue | undefined): string {
  if (value === undefined) return NO_VALUE_SUMMARY
  const text = JSON.stringify(value)
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
}

/**
 * The submitted value of one call, or `undefined` when the arguments are not
 * the object this tool declares. Presentation runs on replayed logs, so it must
 * tolerate arguments a live call could never produce.
 * @param args - the call's arguments, however malformed.
 * @returns the submitted value, when the arguments carry one.
 */
function submittedValue(args: unknown): JsonValue | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  return (args as { readonly value?: JsonValue }).value
}

/**
 * Card metadata one accepted submission records, derived from the submitted
 * value so a UI can present the node result without a tool-specific presenter.
 * @param args - the call's arguments.
 * @returns the persisted presentation metadata.
 */
function cardMeta(args: unknown): CompleteNodeResultMeta {
  return { title: RESULT_TITLE, summary: summarize(submittedValue(args)) }
}

/**
 * Create one attempt's completion tool.
 *
 * The returned definition is what the model calls; {@link CompleteNodeTool.attach}
 * installs it together with its instruction section, its duplicate guard, and
 * the two-phase commit that feeds {@link CompleteNodeToolOptions.onAccept}.
 * @param options - the node's stored output schema and the attempt's sink.
 * @returns the completion tool and its scope wiring.
 */
export function createCompleteNodeTool(options: CompleteNodeToolOptions): CompleteNodeTool {
  const name = options.name ?? COMPLETION_TOOL_NAME
  const parameters = completionParameters(options.outputSchema)
  /**
   * Values staged by the tool body, awaiting their own authoritative
   * `tools/result`. The execution identity is the key, because adapter call ids
   * may repeat across steps while another execution never reaches this entry.
   */
  const staged = new Map<ToolExecution, { readonly value: JsonValue }>()
  /** Successful nested call waiting for its enclosing transport to commit. */
  let pending: { readonly parent: ToolExecution['token']; readonly value: JsonValue } | undefined
  let recorded: { readonly value: JsonValue } | undefined

  const tool: CompleteNodeTool = {
    name,
    description: options.description ?? COMPLETION_TOOL_DESCRIPTION,
    parameters: { ...parameters },
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: RECORDED_TEXT }],
      presentationMeta: args => cardMeta(args),
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
    attach(childCtx: Context): void {
      childCtx.tools.register(tool)

      childCtx.systemPrompt.section({
        name: `tool:${name}`,
        order: childCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
        text: completionInstruction(name),
      })

      // Terminal within the step: guards run after every pre-execute policy and
      // compose monotonically, so a later listener cannot reopen a completed node.
      const complete = (): boolean => recorded !== undefined || pending !== undefined
      childCtx.tools.guard(exec => complete()
        ? `the node result was already recorded, so \`${exec.name}\` is not executed`
        : undefined)

      /** Commit one accepted value; the monotonic guard makes the first the only one. */
      const commit = (value: JsonValue): void => {
        /* v8 ignore if -- the guard rejects every supported call after the first commit */
        if (recorded !== undefined) return
        recorded = { value }
        options.onAccept(value)
      }

      childCtx.on('tools/result', (exec, result) => {
        // A nested submission commits with the enclosing transport's own
        // outcome, which is not this tool's result, so that token is checked
        // before the name filter.
        if (pending?.parent === exec.token) {
          const settled = pending
          pending = undefined
          if (result.isError) return
          commit(settled.value)
          return
        }
        if (exec.name !== name) return
        const entry = staged.get(exec)
        if (entry === undefined) return
        staged.delete(exec)
        if (result.isError) return
        if (exec.parent === undefined) {
          commit(entry.value)
          return
        }
        /* v8 ignore else -- the monotonic guard rejects a second dispatch while one is pending */
        if (pending === undefined) pending = { parent: exec.parent, value: entry.value }
      })
    },
  }
  return tool
}

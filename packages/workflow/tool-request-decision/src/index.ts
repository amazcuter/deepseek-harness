/**
 * The decision tool every workflow agent node receives: the one model-facing
 * way for a node to ask the project coordinator for a decision it cannot make
 * itself.
 *
 * One call records one pending request through {@link RequestDecisionToolOptions.onRequest},
 * returns `{ status: 'pending', requestId }`, and ends the turn with
 * `exec.concludeTurn()`. The node then suspends, which is what releases its
 * scheduler execution slot; the coordinator's answer arrives as the resumed
 * attempt's input, not as another tool result. A second call in the same
 * attempt is refused, so one attempt never leaves two questions open.
 *
 * @module @metaworkflow/tool-request-decision
 */

import { defineTool } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'
import type { DecisionRequest, RequestDecisionResultMeta, RequestDecisionTool, RequestDecisionToolOptions } from './types.ts'

export type {
  DecisionRequest,
  RequestDecisionResultMeta,
  RequestDecisionTool,
  RequestDecisionToolOptions,
} from './types.ts'

/** Model-facing name the decision tool registers under when options omit one. */
export const DECISION_TOOL_NAME = 'request_decision'

/** Model-facing description the decision tool registers when options omit one. */
export const DECISION_TOOL_DESCRIPTION
  = 'Ask the project coordinator to decide something you cannot decide yourself. '
    + 'Call it with your question, optionally listing candidate answers and attaching structured detail; '
    + 'the call ends this turn, so do not call it for something you can resolve from your own inputs.'

/** Card header a pending request's presentation metadata carries. */
export const DECISION_CARD_TITLE = 'Waiting for a coordinator decision'

/** Summary of a request that carries no question, such as a replayed malformed call. */
const NO_QUESTION_SUMMARY = 'no question recorded'

/** Longest summary the presentation metadata keeps, in characters. */
const SUMMARY_LIMIT = 200

/**
 * One-line summary of a requested decision, bounded so a long question cannot
 * bloat the session log's presentation metadata.
 * @param question - the question, or `undefined` for a call that carries none.
 * @returns the summary text.
 */
function summarize(question: string | undefined): string {
  if (question === undefined) return NO_QUESTION_SUMMARY
  return question.length > SUMMARY_LIMIT ? `${question.slice(0, SUMMARY_LIMIT)}…` : question
}

/**
 * The question one call asked, or `undefined` when the arguments are not the
 * object this tool declares. Presentation runs on replayed logs, so it must
 * tolerate arguments a live call could never produce.
 * @param args - the call's arguments, however malformed.
 * @returns the question, when the arguments carry one.
 */
function askedQuestion(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const question = (args as { readonly question?: JsonValue }).question
  return typeof question === 'string' ? question : undefined
}

/**
 * Card metadata one pending request records, derived from the question so a UI
 * can present the wait without a tool-specific presenter.
 * @param args - the call's arguments.
 * @returns the persisted presentation metadata.
 */
function cardMeta(args: unknown): RequestDecisionResultMeta {
  return { title: DECISION_CARD_TITLE, summary: summarize(askedQuestion(args)) }
}

/**
 * Create one attempt's decision tool.
 * @param options - the attempt's request sink and optional name and description.
 * @returns the tool definition plus the scope wiring that installs it.
 */
export function createRequestDecisionTool(options: RequestDecisionToolOptions): RequestDecisionTool {
  const name = options.name ?? DECISION_TOOL_NAME
  /** The request this attempt already recorded; a second call is refused. */
  let pending: { readonly requestId: string } | undefined
  const definition = defineTool({
    name,
    description: options.description ?? DECISION_TOOL_DESCRIPTION,
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The decision you need: one specific question the coordinator can answer.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Candidate answers you propose, in your preferred order. Omit for an open question.',
      },
      detail: {
        type: 'json',
        description: 'Structured context that helps the coordinator answer: the values, files, or tradeoffs involved.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, const: 'pending' },
          requestId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Waiting for the project coordinator to answer decision ${value.requestId}.`,
      }],
      presentationMeta: args => cardMeta(args),
    },
    async execute(args, exec) {
      if (pending !== undefined) {
        throw new Error(
          `this attempt already waits for decision ${pending.requestId}; `
          + 'answer it through the project coordinator instead of asking again',
        )
      }
      const request: DecisionRequest = {
        question: args.question,
        ...args.options === undefined ? {} : { options: args.options },
        ...args.detail === undefined ? {} : { detail: args.detail },
      }
      const requestId = await options.onRequest(request)
      pending = { requestId }
      exec.concludeTurn()
      return { status: 'pending' as const, requestId }
    },
  })
  return {
    ...definition,
    attach(childCtx) {
      childCtx.tools.register(definition)
    },
  }
}

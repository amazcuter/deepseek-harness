/**
 * Public vocabulary of the workflow node decision tool: the request one node
 * asks, the tool factory's options, the returned tool, and the card metadata a
 * pending request records.
 *
 * Types only, per the package convention.
 *
 * @module @metaworkflow/tool-request-decision/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'

/** One question a node asks the project coordinator. */
export interface DecisionRequest {
  /** What the node needs decided before it can continue. */
  readonly question: string
  /** Candidate answers the node proposes, in the order it offered them. */
  readonly options?: readonly string[]
  /** Structured context that helps the coordinator answer. */
  readonly detail?: JsonValue
}

/** Inputs one decision tool needs from the executing attempt. */
export interface RequestDecisionToolOptions {
  /**
   * Model-facing tool name; omitted uses the package default `request_decision`.
   * A distinct name exists for a deployment that must avoid the default, not to
   * run two decision tools in one scope.
   */
  readonly name?: string
  /** Model-facing description; omitted uses the package default. */
  readonly description?: string
  /**
   * Record one request and return its id. Called at most once per attempt, so a
   * consumer writes at most one pending decision for the attempt. A rejection
   * is reported to the model as an error result and leaves the attempt free to
   * ask again.
   * @param request - the question, its optional answers, and its optional detail.
   * @returns the request id the coordinator answers with.
   */
  onRequest(request: DecisionRequest): string | Promise<string>
}

/**
 * The decision tool plus the scope wiring that installs it.
 *
 * Every member of {@link ToolDefinition} is the tool the model calls;
 * {@link RequestDecisionTool.attach} installs that definition in the child
 * Agent's scope. Disposing that scope removes the registration, so two
 * concurrent nodes never observe each other's decision tool.
 */
export interface RequestDecisionTool extends ToolDefinition {
  /**
   * Register the tool on one child Agent's scope.
   * @param childCtx - the child Agent's scope context, during its creation window.
   */
  attach(childCtx: Context): void
}

/**
 * Replayable card metadata one pending request records on its `tool/result`, so
 * a UI can present a waiting card without a tool-specific presenter; a UI that
 * has none falls back to its generic card. The JSON index signature is what
 * makes the payload a lossless JSON object; the two named fields are the ones a
 * consumer reads.
 */
export type RequestDecisionResultMeta = Readonly<Record<string, JsonValue>> & {
  /** Always-visible card header naming what the recorded call did. */
  readonly title: string
  /** Bounded one-line summary of the question. */
  readonly summary: string
}

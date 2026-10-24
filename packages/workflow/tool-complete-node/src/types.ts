/**
 * Public vocabulary of the workflow node completion tool: the options one tool
 * is created from, the tool definition a child scope attaches, and the card
 * metadata an accepted submission records.
 *
 * Types only, per the package convention.
 *
 * @module @metaworkflow/tool-complete-node/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition } from '@metaworkflow/tools'
import type { JsonValue } from '@metaworkflow/util-values'

/** Inputs one completion tool needs from the executing attempt. */
export interface CompleteNodeToolOptions {
  /**
   * Model-facing tool name; omitted uses the package default
   * `submit_node_result`. A distinct name exists for a deployment that must
   * avoid the default, not to run two completion tools in one scope.
   */
  readonly name?: string
  /** Model-facing description; omitted uses the package default. */
  readonly description?: string
  /** The node's stored output schema; the tool's required `value` parameter validates against it. */
  readonly outputSchema: JsonSchemaNode
  /**
   * Receive one accepted value. Called at most once, and only after the
   * submission's own `tools/result` succeeded, so a later pipeline failure
   * cannot leave a completion behind.
   * @param value - the validated node result.
   */
  onAccept(value: JsonValue): void
}

/**
 * The completion tool plus the scope wiring that makes it authoritative.
 *
 * Every member of {@link ToolDefinition} is the tool the model calls;
 * {@link CompleteNodeTool.attach} installs that definition together with its
 * instruction section, its monotonic guard, and the two-phase commit, all in
 * the child Agent's scope. Disposing that scope removes every registration, so
 * two concurrent nodes never observe each other's completion tool.
 */
export interface CompleteNodeTool extends ToolDefinition {
  /**
   * Register the tool, its prompt section, its duplicate guard, and the
   * two-phase commit on one child Agent's scope.
   * @param childCtx - the child Agent's scope context, during its creation window.
   */
  attach(childCtx: Context): void
}

/**
 * Replayable card metadata one accepted submission records on its
 * `tool/result`, so a UI can present a node result without a tool-specific
 * presenter; a UI that has none falls back to its generic card. The JSON
 * index signature is what makes the payload a lossless JSON object; the two
 * named fields are the ones a consumer reads.
 */
export type CompleteNodeResultMeta = Readonly<Record<string, JsonValue>> & {
  /** Always-visible card header naming what the recorded call did. */
  readonly title: string
  /** Bounded one-line JSON text of the submitted value. */
  readonly summary: string
}

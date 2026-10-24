/**
 * Python node executor for the workflow scheduler (`ctx.mwfPythonExecutor`).
 *
 * The scheduler owns readiness, retries, concurrency, and persistence, and it
 * ships no node implementation. This plugin supplies the `python` kind: when
 * the scheduler dispatches an activation, the executor reads the run's stored
 * definition revision, runs the node's source through `ctx.mwfPythonRunner`
 * inside the project working directory, and reports the node's JSON value or a
 * structured failure.
 *
 * The executor owns no scheduling state and writes none: it reads the
 * definition and the project record, and everything durable about the run stays
 * in the project database the scheduler commits. One execution reports at most
 * one outcome, so a node's own failure never aborts a run's other work through
 * a thrown error; only an abort propagates, because the scheduler must observe
 * that the attempt stopped on purpose.
 *
 * @module @metaworkflow/workflow-python-executor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseDefinitionDocument } from '@metaworkflow/workflow-definition'
import type { NodeActivation, NodeExecutor, NodeInputs, NodeResult } from '@metaworkflow/workflow-scheduler'
import type { JsonValue } from '@metaworkflow/util-values'
import { PythonRunnerError } from '@metaworkflow/workflow-python-runner'
import type { RunNodeResult } from '@metaworkflow/workflow-python-runner'
import type { ProjectRecord, DefinitionRecord } from '@metaworkflow/workflow-project-store'
// Type-only: brings the scheduler, runner, and store services into the Context type.
import type {} from '@metaworkflow/workflow-scheduler'
import type {} from '@metaworkflow/workflow-python-runner'
import type {} from '@metaworkflow/workflow-project-store'
import type { Config, PythonExecutorErrorCode } from './types.ts'

export type * from './types.ts'

/** Schemastery validator for {@link Config}. */
export const ConfigSchema: z<Config> = z.object({
  timeoutMs: z.natural(),
})

/**
 * One failure this executor reports, distinguished from an unexpected error so
 * the caller can keep its stable code.
 */
class PythonExecutorError extends Error {
  override readonly name: string = 'PythonExecutorError'

  /** Stable code the scheduler records on the attempt. */
  readonly code: PythonExecutorErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the definition, project, or node.
   * @param options - standard `Error` options, including the underlying `cause`.
   */
  constructor(code: PythonExecutorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfPythonExecutor: PythonExecutor
  }
}

/**
 * Describe any thrown value for a failure message.
 * @param error - value a rejected call threw.
 * @returns the error's message, or the value rendered as text.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Report a failure with the diagnostic the runner captured.
 *
 * The scheduler records one code and one message per attempt, so the captured
 * stderr travels inside the message: a traceback is what an operator needs, and
 * the runner already bounded each stream by its own configuration.
 * @param failure - the code and message the runner reported.
 * @param result - the captured run facts the failure arrived with.
 * @returns the failure the scheduler records.
 */
function nodeFailure(failure: RunNodeResult['error'], result: RunNodeResult): { readonly code: string; readonly message: string } {
  const code = failure?.code ?? 'node/exception'
  const reason = failure?.message ?? 'the node reported no failure detail'
  const stderr = result.stderr.trim()
  return { code, message: stderr.length === 0 ? reason : `${reason}\n--- node stderr ---\n${stderr}` }
}

/**
 * Runs workflow python nodes for the scheduler.
 *
 * One instance owns one executor registration for the `python` kind, which is
 * an effect: disposing the plugin unregisters it, so a replaced plugin never
 * leaves a duplicate executor behind.
 */
export default class PythonExecutor extends Service {
  static inject = ['mwfScheduler', 'mwfPythonRunner', 'mwfProjectStore']

  static Config: z<Config> = ConfigSchema

  private readonly settings: Config

  /**
   * @param ctx - plugin context that owns the service and the registration lifetime.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mwfPythonExecutor')
    this.settings = config
    ctx.effect(() => this.ctx.mwfScheduler.registerExecutor(this.executor()), 'mwfPythonExecutor.register')
  }

  /**
   * Run one activation's python node.
   *
   * The stored definition revision is authoritative for what the run executes:
   * the executor reads the revision the run was created from and takes the
   * node's source from it, so a scheduler-provided node object never supplies
   * code this run did not store.
   * @param activation - the node, its iteration and attempt number, and the run's parameters.
   * @param inputs - the assembled input values, keyed by binding name.
   * @param signal - aborted when the run is paused or canceled.
   * @returns the node's JSON value, or a structured failure.
   * @throws the abort reason when `signal` aborted, because that outcome is not a node failure.
   */
  async execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult> {
    signal.throwIfAborted()
    try {
      const source = await this.storedSource(activation)
      const project = await this.openProject(activation)
      await this.ctx.mwfPythonRunner.ensureVenv(project.path)
      const result = await this.ctx.mwfPythonRunner.runNode({
        projectDir: project.path,
        nodeId: activation.node.id,
        source,
        inputs,
        ...(this.settings.timeoutMs === undefined ? {} : { timeoutMs: this.settings.timeoutMs }),
        signal,
      })
      if (result.ok) {
        // The runner parsed this from the node's JSON result line, so it is JSON by construction;
        // a run that returned nothing and one that returned JSON null are the same value to routing.
        return { status: 'succeeded', value: (result.value ?? null) as JsonValue }
      }
      return {
        status: 'failed',
        error: nodeFailure(result.error, result),
        // A node that ran out of wall clock is the one outcome another attempt may still fit.
        retryable: result.error?.code === 'node/timeout',
      }
    } catch (error: unknown) {
      // An abort is not a node failure: the scheduler must see the attempt stop on purpose.
      if (signal.aborted) throw error
      return { status: 'failed', error: this.structuredFailure(error), retryable: false }
    }
  }

  /**
   * The exported registration the scheduler dispatches `python` activations to.
   * @returns the executor for one node kind.
   */
  private executor(): NodeExecutor {
    return { kind: 'python', execute: async (activation, inputs, signal) => await this.execute(activation, inputs, signal) }
  }

  /**
   * Read the node's source from the run's stored definition revision.
   * @param activation - the activation whose node source is required.
   * @returns the Python source text the runner executes.
   * @throws {@link PythonExecutorError} `python/definition-unavailable` when the
   * revision is missing or does not parse, `python/node-unavailable` when the
   * document declares no python node under that id.
   */
  private async storedSource(activation: NodeActivation): Promise<string> {
    let record: DefinitionRecord | undefined
    try {
      record = await this.ctx.mwfProjectStore.readDefinition(activation.projectId, activation.definitionRevision)
    } catch (error: unknown) {
      throw new PythonExecutorError(
        'python/definition-unavailable',
        `definition revision ${String(activation.definitionRevision)} of project "${activation.projectId}" could not be read: ${describe(error)}`,
        { cause: error },
      )
    }
    if (record === undefined) {
      throw new PythonExecutorError(
        'python/definition-unavailable',
        `workflow project "${activation.projectId}" stores no definition revision ${String(activation.definitionRevision)}`,
      )
    }
    const parsed = parseDefinitionDocument(record.document)
    if (!parsed.ok) {
      const reasons = parsed.violations.map(violation => `${violation.code} at ${violation.path.length === 0 ? '/' : violation.path}`).join(', ')
      throw new PythonExecutorError(
        'python/definition-unavailable',
        `definition revision ${String(record.revision)} of project "${activation.projectId}" is not executable: ${reasons}`,
      )
    }
    const node = parsed.definition.nodes.find(candidate => candidate.id === activation.node.id)
    if (node === undefined || node.config.kind !== 'python') {
      throw new PythonExecutorError(
        'python/node-unavailable',
        `definition revision ${String(record.revision)} of project "${activation.projectId}" declares no python node "${activation.node.id}"`,
      )
    }
    return node.config.source
  }

  /**
   * Open the project that owns the run's working directory.
   * @param activation - the activation whose project is required.
   * @returns the project record, with its absolute working directory.
   * @throws {@link PythonExecutorError} `python/project-unavailable` when the
   * project cannot be opened.
   */
  private async openProject(activation: NodeActivation): Promise<ProjectRecord> {
    try {
      return await this.ctx.mwfProjectStore.openProject(activation.projectId)
    } catch (error: unknown) {
      throw new PythonExecutorError(
        'python/project-unavailable',
        `workflow project "${activation.projectId}" could not be opened: ${describe(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * Convert a thrown value into the failure the scheduler records.
   * @param error - value one execution step threw.
   * @returns the stable code and actionable message.
   */
  private structuredFailure(error: unknown): { readonly code: string; readonly message: string } {
    if (error instanceof PythonExecutorError || error instanceof PythonRunnerError) {
      return { code: error.code, message: error.message }
    }
    return { code: 'python/executor-failed', message: `the python executor failed: ${describe(error)}` }
  }
}

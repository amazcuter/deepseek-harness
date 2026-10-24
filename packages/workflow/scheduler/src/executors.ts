/**
 * The executor registry: one {@link NodeExecutor} per node kind, owned by the
 * service so a disposed scheduler leaves no executor behind.
 *
 * @module @metaworkflow/workflow-scheduler/executors
 */

import { WorkflowSchedulerError } from './errors.ts'
import type { NodeExecutor } from './types.ts'

/** Executors registered for the node kinds of one scheduler instance. */
export class ExecutorRegistry {
  private readonly executors = new Map<NodeExecutor['kind'], NodeExecutor>()

  /**
   * Register one executor.
   * @param executor - executor to register.
   * @returns the disposer that unregisters it, which is what `ctx.effect` keeps.
   * @throws {@link WorkflowSchedulerError} `scheduler/duplicate-executor` when the
   * kind already has an executor; a second implementation replaces the first only
   * by composition, never by silent override.
   */
  register(executor: NodeExecutor): () => void {
    if (this.executors.has(executor.kind)) {
      throw new WorkflowSchedulerError(
        'scheduler/duplicate-executor',
        `an executor for node kind "${executor.kind}" is already registered`,
      )
    }
    this.executors.set(executor.kind, executor)
    return () => {
      if (this.executors.get(executor.kind) === executor) this.executors.delete(executor.kind)
    }
  }

  /**
   * The executor for one node kind.
   * @param kind - node kind a ready activation needs.
   * @returns the registered executor, or `undefined` when the composition registers none.
   */
  find(kind: NodeExecutor['kind']): NodeExecutor | undefined {
    return this.executors.get(kind)
  }

  /** Drop every registration, so a disposed service holds no reference. */
  clear(): void {
    this.executors.clear()
  }
}

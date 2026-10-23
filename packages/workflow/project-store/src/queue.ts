/**
 * Serial write queue: one tail promise that every queued write extends.
 *
 * A `DatabaseSync` connection answers synchronously, but a write may need to
 * wait for its database to open, so the store orders writes instead of
 * depending on `busy_timeout` to arbitrate them.
 *
 * @module @metaworkflow/workflow-project-store/queue
 */

/** Tail-promise queue that never runs two writes at once. */
export class SerialWriteQueue {
  private tail: Promise<void> = Promise.resolve()

  /**
   * Queue one operation behind every earlier operation.
   *
   * A failed operation settles its own caller's promise and leaves the queue
   * usable: later operations still run, in submission order.
   * @param operation - body to run once every earlier operation settled.
   * @returns the operation's own result or rejection.
   */
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Wait until every operation submitted so far has settled.
   * @returns resolution once the queue is empty, never a rejection.
   */
  settled(): Promise<void> {
    return this.tail
  }
}

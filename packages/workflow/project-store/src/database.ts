/**
 * One lazily opened database file per layout slot.
 *
 * Every database the store opens is held through a slot, which is what keeps a
 * process to one `DatabaseSync` connection per database file: concurrent
 * callers share the pending open, later callers reuse the live handle, and a
 * failed open leaves the slot reusable.
 *
 * @module @metaworkflow/workflow-project-store/database
 */

import type { DatabaseSync } from 'node:sqlite'
import { SerialWriteQueue } from './queue.ts'

/** One database file: its connection, its write queue, and their lifetime. */
export class DatabaseSlot {
  /** Serial queue every write against this connection runs through. */
  readonly queue = new SerialWriteQueue()

  private readonly open: () => Promise<DatabaseSync>
  private handle: DatabaseSync | undefined
  private opening: Promise<DatabaseSync> | undefined

  /**
   * @param open - opener invoked at most once per connection lifetime.
   */
  constructor(open: () => Promise<DatabaseSync>) {
    this.open = open
  }

  /**
   * The connection, opening the file on first use and sharing one open across
   * concurrent callers.
   * @returns the live connection owned by this slot.
   */
  async connection(): Promise<DatabaseSync> {
    if (this.handle !== undefined) return this.handle
    this.opening ??= this.open().then((db) => {
      this.handle = db
      return db
    })
    try {
      return await this.opening
    } catch (error: unknown) {
      // A failed open leaves no handle, so the next caller retries instead of
      // inheriting the failure for the rest of the process.
      this.opening = undefined
      throw error
    }
  }

  /**
   * Drain queued writes, then release the connection.
   * @returns resolution once the handle is released and the slot is empty.
   */
  async close(): Promise<void> {
    await this.queue.settled()
    this.handle?.close()
    this.handle = undefined
    this.opening = undefined
  }
}

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectDatabase, runTransaction } from '../src/index.ts'
import { DatabaseSlot } from '../src/database.ts'
import { SerialWriteQueue } from '../src/queue.ts'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mwf-project-store-primitives-'))
  directories.push(directory)
  return join(directory, 'project.db')
}

describe('SerialWriteQueue', () => {
  it('runs operations in submission order, one at a time', async () => {
    const queue = new SerialWriteQueue()
    const events: string[] = []
    const first = queue.run(async () => {
      events.push('first:start')
      await Promise.resolve()
      events.push('first:end')
      return 1
    })
    const second = queue.run(() => {
      events.push('second')
      return 2
    })
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('keeps the queue usable after a failed operation', async () => {
    const queue = new SerialWriteQueue()
    const failure = queue.run(() => {
      throw new Error('write failed')
    })
    const later = queue.run(() => 'later')
    await expect(failure).rejects.toThrow('write failed')
    await expect(later).resolves.toBe('later')
    await expect(queue.settled()).resolves.toBeUndefined()
  })

  it('settles after every queued operation finished', async () => {
    const queue = new SerialWriteQueue()
    let finished = false
    const pending = queue.run(async () => {
      await Promise.resolve()
      finished = true
    })
    await queue.settled()
    expect(finished).toBe(true)
    await pending
  })
})

describe('runTransaction', () => {
  it('commits a completed batch and returns its value', async () => {
    const db = await openProjectDatabase(await temporaryDatabase())
    try {
      const revision = runTransaction(db, () => {
        db.prepare('INSERT INTO definitions (revision, document, created_at) VALUES (?, ?, ?)').run(1, 'committed', 1)
        return 1
      })
      expect(revision).toBe(1)
      expect(db.prepare('SELECT document FROM definitions WHERE revision = 1').get()).toEqual({ document: 'committed' })
    } finally {
      db.close()
    }
  })

  it('rolls the whole batch back and leaves no trace', async () => {
    const db = await openProjectDatabase(await temporaryDatabase())
    try {
      expect(() => runTransaction(db, () => {
        db.prepare('INSERT INTO definitions (revision, document, created_at) VALUES (?, ?, ?)').run(1, 'rolled back', 1)
        throw new Error('batch failed')
      })).toThrow('batch failed')
      expect(db.prepare('SELECT COUNT(*) AS count FROM definitions').get()).toEqual({ count: 0 })
      // The rolled-back key is free again, so the batch left no residue behind.
      runTransaction(db, () => {
        db.prepare('INSERT INTO definitions (revision, document, created_at) VALUES (?, ?, ?)').run(1, 'retried', 2)
      })
      expect(db.prepare('SELECT document FROM definitions WHERE revision = 1').get()).toEqual({ document: 'retried' })
    } finally {
      db.close()
    }
  })
})

describe('DatabaseSlot', () => {
  it('opens one connection for concurrent and later callers', async () => {
    const path = await temporaryDatabase()
    let opens = 0
    const slot = new DatabaseSlot(async () => {
      opens += 1
      return openProjectDatabase(path)
    })
    try {
      const [first, second] = await Promise.all([slot.connection(), slot.connection()])
      const third = await slot.connection()
      expect(opens).toBe(1)
      expect(first).toBe(second)
      expect(third).toBe(first)
    } finally {
      await slot.close()
    }
  })

  it('retries the open after a failure', async () => {
    const path = await temporaryDatabase()
    let attempts = 0
    const slot = new DatabaseSlot(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('first open failed')
      return openProjectDatabase(path)
    })
    try {
      await expect(slot.connection()).rejects.toThrow('first open failed')
      const db = await slot.connection()
      expect(attempts).toBe(2)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    } finally {
      await slot.close()
    }
  })

  it('drains queued writes before releasing the connection', async () => {
    const path = await temporaryDatabase()
    const slot = new DatabaseSlot(async () => openProjectDatabase(path))
    let written = false
    const write = slot.queue.run(async () => {
      await Promise.resolve()
      written = true
    })
    await slot.close()
    await write
    expect(written).toBe(true)
  })

  it('closes a slot that never opened and reopens after the close', async () => {
    const path = await temporaryDatabase()
    let opens = 0
    const slot = new DatabaseSlot(async () => {
      opens += 1
      return openProjectDatabase(path)
    })
    await slot.close()
    expect(opens).toBe(0)
    const first = await slot.connection()
    expect(first.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    await slot.close()
    const second = await slot.connection()
    try {
      expect(opens).toBe(2)
      expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    } finally {
      await slot.close()
    }
  })
})

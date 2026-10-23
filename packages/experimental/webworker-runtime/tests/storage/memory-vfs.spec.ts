/**
 * The identity, timestamp, link, mutation, and durability-sink guarantees
 * MemoryVfs owes its consumers, asserted directly rather than through the
 * `node:fs` bridge.
 *
 * `mwf-fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsMutation, VfsMutationSink, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const linkCount = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).nlink

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/one.txt', 'one')
    vfs.seed('/mwf/two.txt', 'two')
    const first = identity(vfs, '/mwf/one.txt')
    expect(identity(vfs, '/mwf/two.txt')).not.toBe(first)
    expect(identity(vfs, '/mwf/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '/mwf/skills/git/SKILL.md')
    vfs.rmSync('/mwf/skills', { recursive: true })
    vfs.seed('/mwf/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '/mwf/skills/git/SKILL.md')).not.toBe(before)
  })

  it('moves the source identity when a file replaces another path', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/from.txt', 'moved')
    vfs.seed('/mwf/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '/mwf/from.txt'), identity(vfs, '/mwf/to.txt')]
    vfs.renameSync('/mwf/from.txt', '/mwf/to.txt')
    const renamed = identity(vfs, '/mwf/to.txt')
    expect(vfs.readFileSync('/mwf/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([true, false])
  })
})

describe('modification time', () => {
  it('hydrates explicit metadata without confusing timestamps with permission bits', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/restored', 'value', { mode: 0o600, mtimeMs: 1_600_000_000_000 })
    vfs.seedDirectory('/mwf/restored-directory', { mode: 0o700, mtimeMs: 1_600_000_000_001 })
    const stats = vfs.statSync('/mwf/restored') as VfsStats
    const directory = vfs.statSync('/mwf/restored-directory') as VfsStats
    expect([stats.mode & 0o777, stats.mtimeMs]).toEqual([0o600, 1_600_000_000_000])
    expect([directory.mode & 0o777, directory.mtimeMs]).toEqual([0o700, 1_600_000_000_001])
  })

  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/log.jsonl', 'first\n')
    const seeded = modified(vfs, '/mwf/log.jsonl')
    vfs.writeFileSync('/mwf/log.jsonl', 'second\n')
    const written = modified(vfs, '/mwf/log.jsonl')
    vfs.appendFileSync('/mwf/log.jsonl', 'third\n')
    const appended = modified(vfs, '/mwf/log.jsonl')
    vfs.truncateSync('/mwf/log.jsonl', 6)
    const truncated = modified(vfs, '/mwf/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('/mwf/log.jsonl', 'second\n')
    expect(modified(vfs, '/mwf/log.jsonl')).toBe(1_700_000_005_000)
  })

  it('extends truncation with zero bytes', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/file', new Uint8Array([1, 2]))
    vfs.truncateSync('/mwf/file', 5)
    expect([...vfs.readFileSync('/mwf/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0])
    const handle = vfs.open('/mwf/file', 'r+')
    await handle.truncate(7)
    expect([...vfs.readFileSync('/mwf/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0, 0, 0])
  })

  it('advances a directory only when its immediate entry set changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/mwf/workspace')
    const empty = modified(vfs, '/mwf/workspace')
    vfs.writeFileSync('/mwf/workspace/file.txt', 'one')
    const created = modified(vfs, '/mwf/workspace')
    vfs.writeFileSync('/mwf/workspace/file.txt', 'two')
    const rewritten = modified(vfs, '/mwf/workspace')
    vfs.rmSync('/mwf/workspace/file.txt')
    const removed = modified(vfs, '/mwf/workspace')
    expect([created > empty, rewritten === created, removed > rewritten]).toEqual([true, true, true])
  })
})

describe('mutation publication', () => {
  it('publishes only committed runtime changes and keeps image seeding silent', () => {
    const vfs = new MemoryVfs()
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.seed('/mwf/seeded.txt', 'seeded')
    expect(mutations).toEqual([])
    vfs.writeFileSync('/mwf/seeded.txt', 'changed')
    vfs.mkdirSync('/mwf/created')
    vfs.chmodSync('/mwf/created', 0o700)
    vfs.renameSync('/mwf/seeded.txt', '/mwf/renamed.txt')
    vfs.rmSync('/mwf/created', { recursive: true })
    expect(mutations.map(mutation => ({
      kind: mutation.kind,
      path: mutation.path,
      ...mutation.kind === 'write' ? { entryChanged: mutation.entryChanged } : {},
      ...mutation.kind === 'chmod' ? { mode: mutation.mode } : {},
    }))).toEqual([
      { kind: 'write', path: '/mwf/seeded.txt', entryChanged: false },
      { kind: 'mkdir', path: '/mwf/created' },
      { kind: 'chmod', path: '/mwf/created', mode: 0o700 },
      { kind: 'remove', path: '/mwf/seeded.txt' },
      { kind: 'write', path: '/mwf/renamed.txt', entryChanged: true },
      { kind: 'remove', path: '/mwf/created' },
    ])
    const renamed = mutations[4]
    expect(renamed?.kind === 'write' && new TextDecoder().decode(renamed.bytes)).toBe('changed')
    expect(() => { vfs.writeFileSync('/missing/file', 'no') }).toThrow(/ENOENT/)
    expect(mutations).toHaveLength(6)
  })

  it('contains a faulty observer and lets disposal stop later notifications', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/mwf')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vfs.subscribe(() => { throw new Error('observer failed') })
    const seen: string[] = []
    const second = vfs.subscribe((mutation) => { seen.push(mutation.path) })
    vfs.writeFileSync('/mwf/one', '1')
    first()
    second()
    vfs.writeFileSync('/mwf/two', '2')
    expect(seen).toEqual(['/mwf/one'])
    expect(reported).toHaveBeenCalledOnce()
  })

  it('feeds the same complete mutations to a durable sink and live subscribers', async () => {
    const recorded: VfsMutation[] = []
    let flushes = 0
    const sink: VfsMutationSink = {
      record: (mutation) => { recorded.push(mutation) },
      flush: async () => { flushes += 1 },
    }
    const vfs = new MemoryVfs({ sink })
    vfs.seedDirectory('/mwf')
    const observed: VfsMutation[] = []
    vfs.subscribe((mutation) => { observed.push(mutation) })
    vfs.writeFileSync('/mwf/log', 'a')
    vfs.appendFileSync('/mwf/log', 'bc')
    await vfs.flush()
    expect(observed).toEqual(recorded)
    expect(observed[0]).toBe(recorded[0])
    expect(recorded[0]).toMatchObject({ kind: 'write', path: '/mwf/log', mode: 0o644, entryChanged: true })
    expect(recorded[1]).toMatchObject({ kind: 'write', path: '/mwf/log', mode: 0o644, entryChanged: false, appendedFrom: 1 })
    expect(recorded[1]?.kind === 'write' && new TextDecoder().decode(recorded[1].bytes)).toBe('abc')
    expect(flushes).toBe(1)
  })

  it('publishes descriptor writes at the file identity current path', () => {
    const mutations: VfsMutation[] = []
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/source', 'old')
    const descriptor = vfs.openFileSync('/mwf/source', 'r+')
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.renameSync('/mwf/source', '/mwf/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('new'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/mwf/destination'])
    expect(vfs.readFileSync('/mwf/destination', 'utf8')).toBe('new')
    vfs.unlinkSync('/mwf/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('detached'))
    expect(mutations).toEqual([])
    expect(new TextDecoder().decode(descriptor.read(0, descriptor.stat().size))).toBe('detached')
  })

  it('reports the path identity through a BigInt file handle stat', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/session.lock', '')
    const handle = vfs.open('/mwf/session.lock', 'w')
    const held = await handle.stat({ bigint: true }) as VfsBigIntStats
    const current = vfs.statSync('/mwf/session.lock', { bigint: true }) as VfsBigIntStats

    expect([held.dev, held.ino]).toEqual([current.dev, current.ino])
    await handle.chmod(0o600)
    expect((vfs.statSync('/mwf/session.lock') as VfsStats).mode & 0o777).toBe(0o600)
    await handle.close()
  })

  it('decomposes a directory rename into replayable destination state', () => {
    const recorded: VfsMutation[] = []
    const vfs = new MemoryVfs({
      sink: { record: (mutation) => { recorded.push(mutation) }, flush: () => Promise.resolve() },
    })
    vfs.seedDirectory('/mwf/staging/nested', { mode: 0o700 })
    vfs.seed('/mwf/staging/nested/file', 'value', { mode: 0o600 })
    vfs.renameSync('/mwf/staging', '/mwf/published')

    expect(recorded.map(mutation => [mutation.kind, mutation.path])).toEqual([
      ['remove', '/mwf/staging'],
      ['mkdir', '/mwf/published'],
      ['mkdir', '/mwf/published/nested'],
      ['write', '/mwf/published/nested/file'],
    ])
    expect(recorded[3]).toMatchObject({ kind: 'write', mode: 0o600, entryChanged: true })
    expect(recorded[3]?.kind === 'write' && new TextDecoder().decode(recorded[3].bytes)).toBe('value')
  })
})

describe('directory rename', () => {
  it('rejects file, non-empty directory, and missing-parent destinations before mutation', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/source/nested/file', 'source')
    vfs.seed('/mwf/file', 'destination')
    vfs.seed('/mwf/non-empty/child', 'destination')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    expect(() => { vfs.renameSync('/mwf/source', '/mwf/file') })
      .toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(() => { vfs.renameSync('/mwf/source', '/mwf/non-empty') })
      .toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }))
    expect(() => { vfs.renameSync('/mwf/source', '/missing/destination') })
      .toThrow(expect.objectContaining({ code: 'ENOENT' }))

    expect(vfs.readFileSync('/mwf/source/nested/file', 'utf8')).toBe('source')
    expect(vfs.readFileSync('/mwf/file', 'utf8')).toBe('destination')
    expect(vfs.readFileSync('/mwf/non-empty/child', 'utf8')).toBe('destination')
    expect(mutations).toEqual([])
  })

  it('replaces an empty directory with the source subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/mwf/source/nested', { mode: 0o700 })
    vfs.seed('/mwf/source/nested/file', 'source')
    vfs.seedDirectory('/mwf/destination', { mode: 0o711 })

    vfs.renameSync('/mwf/source', '/mwf/destination')

    expect(vfs.existsSync('/mwf/source')).toBe(false)
    expect(vfs.readFileSync('/mwf/destination/nested/file', 'utf8')).toBe('source')
    expect((vfs.statSync('/mwf/destination') as VfsStats).mode & 0o777).toBe(0o755)
    expect((vfs.statSync('/mwf/destination/nested') as VfsStats).mode & 0o777).toBe(0o700)
  })
})

describe('hard links', () => {
  it('shares identity, bytes, and mode until one name is removed', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/session.jsonl', 'committed\n')
    vfs.linkSync('/mwf/session.jsonl', '/mwf/session-latest.jsonl')
    vfs.linkSync('/mwf/session-latest.jsonl', '/mwf/session-archive.jsonl')
    expect(identity(vfs, '/mwf/session-latest.jsonl')).toBe(identity(vfs, '/mwf/session.jsonl'))
    expect(linkCount(vfs, '/mwf/session.jsonl')).toBe(3n)
    expect(vfs.readFileSync('/mwf/session-latest.jsonl', 'utf8')).toBe('committed\n')
    const changedPaths: string[] = []
    vfs.subscribe((mutation) => { changedPaths.push(mutation.path) })
    vfs.appendFileSync('/mwf/session.jsonl', 'appended\n')
    expect(changedPaths).toEqual([
      '/mwf/session.jsonl',
      '/mwf/session-latest.jsonl',
      '/mwf/session-archive.jsonl',
    ])
    expect(vfs.readFileSync('/mwf/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('/mwf/session-latest.jsonl', 'utf8')).toBe('committed\nappended\n')
    vfs.chmodSync('/mwf/session-latest.jsonl', 0o600)
    expect((vfs.statSync('/mwf/session.jsonl') as VfsStats).mode & 0o777).toBe(0o600)
    vfs.unlinkSync('/mwf/session-latest.jsonl')
    expect(linkCount(vfs, '/mwf/session.jsonl')).toBe(2n)
    vfs.unlinkSync('/mwf/session-archive.jsonl')
    expect(linkCount(vfs, '/mwf/session.jsonl')).toBe(1n)
    expect(vfs.readFileSync('/mwf/session.jsonl', 'utf8')).toBe('committed\nappended\n')
  })

  it('treats rename between names of the same node as a no-op', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/source', 'value')
    vfs.linkSync('/mwf/source', '/mwf/alias')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    vfs.renameSync('/mwf/source', '/mwf/alias')

    expect(vfs.readFileSync('/mwf/source', 'utf8')).toBe('value')
    expect(vfs.readFileSync('/mwf/alias', 'utf8')).toBe('value')
    expect(linkCount(vfs, '/mwf/source')).toBe(2n)
    expect(mutations).toEqual([])
  })

  it('retargets linked names through file replacement and directory moves', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/replacement', 'replacement')
    vfs.seed('/mwf/target', 'old')
    vfs.linkSync('/mwf/target', '/mwf/target-alias')
    const replaced = vfs.openFileSync('/mwf/target', 'r+')
    vfs.renameSync('/mwf/replacement', '/mwf/target')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    replaced.write(0, new TextEncoder().encode('changed'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/mwf/target-alias'])
    expect(vfs.readFileSync('/mwf/target', 'utf8')).toBe('replacement')
    expect(vfs.readFileSync('/mwf/target-alias', 'utf8')).toBe('changed')
    expect(linkCount(vfs, '/mwf/target-alias')).toBe(1n)

    vfs.seed('/mwf/tree/file', 'tree')
    vfs.linkSync('/mwf/tree/file', '/mwf/outside')
    const moved = vfs.openFileSync('/mwf/tree/file', 'r+')
    vfs.renameSync('/mwf/tree', '/mwf/moved')
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('moved'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/mwf/outside', '/mwf/moved/file'])
    expect(linkCount(vfs, '/mwf/moved/file')).toBe(2n)

    vfs.rmSync('/mwf/moved', { recursive: true })
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('kept!'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['/mwf/outside'])
    expect(vfs.readFileSync('/mwf/outside', 'utf8')).toBe('kept!')
    expect(linkCount(vfs, '/mwf/outside')).toBe(1n)
  })

  it('rejects renaming a file over an existing directory', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/mwf/file', 'value')
    vfs.seedDirectory('/mwf/directory')
    expect(() => { vfs.renameSync('/mwf/file', '/mwf/directory') }).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(vfs.readFileSync('/mwf/file', 'utf8')).toBe('value')
    expect(vfs.statSync('/mwf/directory').isDirectory()).toBe(true)
  })
})

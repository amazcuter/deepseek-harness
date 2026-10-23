/**
 * Behavioural check of this package's `node:fs` bridge over a real MemoryVfs:
 * encoding branches, Dirent, file descriptors, FileHandle append/replace semantics,
 * and Node's error codes.
 *
 * Every import resolves through `src/` so the harness and bridge share the same
 * module-level VFS slot. Mixing the bare package's built entry with `/src/*`
 * imports can create two slots, leaving the bridge with no mounted filesystem.
 */
import { expect, test } from 'vitest'
import { MemoryVfs } from '@metaworkflow/experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@metaworkflow/experimental-webworker-runtime/src/storage/active.ts'
import * as fs from '@metaworkflow/experimental-webworker-runtime/src/node/builtin_modules/implemented/fs.ts'
import * as fsp from '@metaworkflow/experimental-webworker-runtime/src/node/builtin_modules/implemented/fs/promises.ts'
import { promisify } from '@metaworkflow/experimental-webworker-runtime/src/node/builtin_modules/implemented/util.ts'
import type { VfsBigIntStats, VfsMutationSink, VfsStats } from '@metaworkflow/experimental-webworker-runtime/src/storage/types.ts'

let flushes = 0
const sink: VfsMutationSink = {
  record: () => {},
  flush: () => {
    flushes += 1
    return Promise.resolve()
  },
}
const vfs = new MemoryVfs({ sink })
setActiveVfs(vfs)

// Identity precondition: the bridge must read this exact mounted VFS; successful
// calls alone could come from another mounted instance.
fs.mkdirSync('/mwf/.probe', { recursive: true })
fs.writeFileSync('/mwf/.probe/instance', 'x')
if (!vfs.existsSync('/mwf/.probe/instance')) {
  throw new Error('fs-check: the fs bridge is not reading the VFS this harness mounted '
    + '(two module instances — check that every import resolves through src/)')
}
vfs.rmSync('/mwf/.probe', { recursive: true })

const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}
const throws = (label: string, run: () => unknown, code: string): void => {
  let outcome: string
  try {
    run()
    outcome = 'did not throw'
  } catch (error) {
    outcome = (error as { code?: string }).code ?? (error as Error).message
  }
  test(label, () => { expect(outcome).toContain(code) })
}

fs.mkdirSync('/mwf/config', { recursive: true })
fs.writeFileSync('/mwf/config/cordis.yml', '- id: timer\n')
check('readFileSync utf8', fs.readFileSync('/mwf/config/cordis.yml', 'utf8'), '- id: timer\n')
check('readFileSync options object', fs.readFileSync('/mwf/config/cordis.yml', { encoding: 'utf8' }), '- id: timer\n')
check('readFileSync bytes length', (fs.readFileSync('/mwf/config/cordis.yml') as Uint8Array).byteLength, 12)
check('readFileSync is Buffer', Buffer.isBuffer(fs.readFileSync('/mwf/config/cordis.yml')), true)
check('existsSync true', fs.existsSync('/mwf/config/cordis.yml'), true)
check('existsSync false', fs.existsSync('/mwf/nope'), false)
check('statSync isFile', fs.statSync('/mwf/config/cordis.yml').isFile(), true)
check('statSync size', fs.statSync('/mwf/config/cordis.yml').size, 12)
check('statSync dir', fs.statSync('/mwf/config').isDirectory(), true)
check('realpathSync', fs.realpathSync('/mwf/config/../config/cordis.yml'), '/mwf/config/cordis.yml')

test('native realpath supports the filesystem provider promise wrapper', async () => {
  expect(fs.default.realpath).toBe(fs.realpath)
  const resolveNative = promisify(fs.realpath.native)
  expect(await resolveNative('/mwf/config/../config/cordis.yml')).toBe('/mwf/config/cordis.yml')
  await expect(resolveNative('/mwf/missing-realpath')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('callback realpath settles after the current call returns', async () => {
  let returned = false
  const completion = new Promise<unknown>((resolve) => {
    fs.realpath('/mwf/config/cordis.yml', (error, path) => { resolve({ error, path, returned }) })
  })
  returned = true
  expect(await completion).toEqual({ error: null, path: '/mwf/config/cordis.yml', returned: true })
})

fs.appendFileSync('/mwf/config/cordis.yml', '- id: llm\n')
check('appendFileSync', fs.readFileSync('/mwf/config/cordis.yml', 'utf8'), '- id: timer\n- id: llm\n')

fs.mkdirSync('/mwf/config/agent-presets/standard', { recursive: true })
fs.writeFileSync('/mwf/config/agent-presets/standard/SKILL.md', '# skill\n')
check('readdirSync names', fs.readdirSync('/mwf/config'), ['agent-presets', 'cordis.yml'])
const entries = fs.readdirSync('/mwf/config', { withFileTypes: true }) as fs.Dirent[]
check('readdirSync withFileTypes', entries.map(entry => [entry.name, entry.isFile(), entry.isDirectory()]), [
  ['agent-presets', false, true],
  ['cordis.yml', true, false],
])
check('Dirent parentPath', entries[0]!.parentPath, '/mwf/config')

const temporary = fs.mkdtempSync('/mwf/tmp/run-')
check('mkdtempSync creates directory', fs.statSync(temporary).isDirectory(), true)
check('mkdtempSync unique', fs.mkdtempSync('/mwf/tmp/run-') === temporary, false)

throws('readFileSync missing', () => fs.readFileSync('/mwf/missing'), 'ENOENT')
throws('statSync missing', () => fs.statSync('/mwf/missing'), 'ENOENT')
throws('accessSync missing', () =>{  fs.accessSync('/mwf/missing') }, 'ENOENT')
throws('readdirSync missing', () => fs.readdirSync('/mwf/missing'), 'ENOENT')
const appendFd = fs.openSync('/mwf/log.jsonl', 'a')
fs.writeSync(appendFd, '{"a":1}\n')
fs.writeSync(appendFd, '{"a":2}\n')
fs.closeSync(appendFd)
check('append fd writes', fs.readFileSync('/mwf/log.jsonl', 'utf8'), '{"a":1}\n{"a":2}\n')

const readFd = fs.openSync('/mwf/log.jsonl', 'r')
const target = new Uint8Array(8)
check('readSync count', fs.readSync(readFd, target, 0, 8), 8)
check('readSync bytes', new TextDecoder().decode(target), '{"a":1}\n')
check('readSync continues', fs.readSync(readFd, target, 0, 8), 8)
check('readSync second line', new TextDecoder().decode(target), '{"a":2}\n')
check('readSync at eof', fs.readSync(readFd, target, 0, 8), 0)
fs.closeSync(readFd)
throws('closed fd', () => fs.readSync(readFd, target, 0, 8), 'EBADF')

const writeFd = fs.openSync('/mwf/truncated.txt', 'w')
fs.writeSync(writeFd, 'abc')
fs.closeSync(writeFd)
check('write fd truncates', fs.readFileSync('/mwf/truncated.txt', 'utf8'), 'abc')

fs.renameSync('/mwf/truncated.txt', '/mwf/renamed.txt')
check('renameSync moves', [fs.existsSync('/mwf/truncated.txt'), fs.readFileSync('/mwf/renamed.txt', 'utf8')], [false, 'abc'])
fs.rmSync('/mwf/renamed.txt')
check('rmSync removes', fs.existsSync('/mwf/renamed.txt'), false)

// A FileHandle opened for appending must append, not replace: the JSONL session
// log writes its header frame first and every batch after it through this path.
fs.writeFileSync('/mwf/log-handle.jsonl', 'header\n')
const appendHandle = await fsp.open('/mwf/log-handle.jsonl', 'a')
check('append handle sees the existing size', (await appendHandle.stat()).size, 7)
const appendHandleStats = await appendHandle.stat({ bigint: true }) as VfsBigIntStats
const appendPathStats = await fsp.stat('/mwf/log-handle.jsonl', { bigint: true }) as VfsBigIntStats
check('bigint handle stat matches the path identity', [
  typeof appendHandleStats.ino,
  appendHandleStats.ino === appendPathStats.ino,
  appendHandleStats.dev === appendPathStats.dev,
], ['bigint', true, true])
await appendHandle.writeFile('batch-1\n')
await appendHandle.sync()
check('handle.sync flushes the active VFS', flushes, 1)
await appendHandle.close()
const secondHandle = await fsp.open('/mwf/log-handle.jsonl', 'a')
await secondHandle.writeFile('batch-2\n')
await secondHandle.close()
check('handle.writeFile appends in append mode', fs.readFileSync('/mwf/log-handle.jsonl', 'utf8'), 'header\nbatch-1\nbatch-2\n')
const replaceHandle = await fsp.open('/mwf/log-handle.jsonl', 'w')
await replaceHandle.writeFile('replaced\n')
await replaceHandle.close()
check('handle.writeFile replaces without append mode', fs.readFileSync('/mwf/log-handle.jsonl', 'utf8'), 'replaced\n')
const truncHandle = await fsp.open('/mwf/log-handle.jsonl', 'r+')
await truncHandle.truncate(4)
await truncHandle.close()
check('handle.truncate cuts the tail', fs.readFileSync('/mwf/log-handle.jsonl', 'utf8'), 'repl')

check('promises.readFile', await fsp.readFile('/mwf/config/cordis.yml', 'utf8'), '- id: timer\n- id: llm\n')
await fsp.writeFile('/mwf/promise.txt', 'p')
check('promises.writeFile', fs.readFileSync('/mwf/promise.txt', 'utf8'), 'p')
check('promises.stat', (await fsp.stat('/mwf/promise.txt')).isFile(), true)
await fsp.cp('/mwf/config', '/mwf/config-copy')
check('promises.cp tree', await fsp.readFile('/mwf/config-copy/agent-presets/standard/SKILL.md', 'utf8'), '# skill\n')
await fsp.rm('/mwf/config-copy', { recursive: true })
check('promises.rm recursive', fs.existsSync('/mwf/config-copy'), false)

// ---------------------------------------------------------------------------
// The `{ bigint: true }` stats the filesystem service reads.
//
// `mwf-fs-local` stats EVERY target this way before it lists or reads: it masks
// `mode` with a BigInt literal and builds its version token from
// `dev:ino:size:mtimeNs:ctimeNs`. A number-valued `mode` here made that mask
// throw `Cannot mix BigInt and other types`, which the service reported as
// FS_IO_ERROR and skill discovery swallowed as "empty directory" — the worker
// booted with an empty skill catalog and no error anywhere.
// ---------------------------------------------------------------------------

const bigStats = (path: string): VfsBigIntStats => fs.statSync(path, { bigint: true }) as VfsBigIntStats

fs.writeFileSync('/mwf/versioned.txt', 'one')
{
  const stats = bigStats('/mwf/versioned.txt')
  check('bigint stat reports mode as a BigInt', typeof stats.mode, 'bigint')
  check('bigint mode masks to the creation-default file permission', Number(stats.mode & 0o777n), 0o644)
  check('bigint stat reports the identity fields the version token needs', [
    typeof stats.dev, typeof stats.ino, typeof stats.size, typeof stats.mtimeNs, typeof stats.ctimeNs,
  ], ['bigint', 'bigint', 'bigint', 'bigint', 'bigint'])
  check('bigint nanosecond time scales the millisecond time', stats.mtimeNs === stats.mtimeMs * 1_000_000n, true)
  check('bigint stat still answers the type predicates', [stats.isFile(), stats.isDirectory()], [true, false])
  check('plain stat keeps its number shape', typeof fs.statSync('/mwf/versioned.txt').mode, 'number')
}

{
  // Two writes inside one millisecond must not produce one version: the service's
  // stale-write guard compares these tokens.
  const token = (path: string): string => {
    const stats = bigStats(path)
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
  }
  const before = token('/mwf/versioned.txt')
  fs.writeFileSync('/mwf/versioned.txt', 'two')
  check('a rewrite changes the version token', token('/mwf/versioned.txt') !== before, true)
  check('an unchanged file keeps its version token', token('/mwf/versioned.txt'), token('/mwf/versioned.txt'))
}

{
  const first = bigStats('/mwf/versioned.txt').ino
  fs.writeFileSync('/mwf/versioned.txt', 'three')
  check('identity survives a write to the same path', String(bigStats('/mwf/versioned.txt').ino), String(first))
  fs.rmSync('/mwf/versioned.txt')
  fs.writeFileSync('/mwf/versioned.txt', 'four')
  check('a removed and recreated path reports a new identity', bigStats('/mwf/versioned.txt').ino !== first, true)
}

check('a directory reports the creation-default mode in the bigint shape', Number(bigStats('/mwf/config').mode & 0o777n), 0o755)

// ---------------------------------------------------------------------------
// Permission bits round-trip: creation takes the caller's mode, chmod changes
// it, stat reads back the stored value. mwf-credentials-local's owner-only
// check reads exactly this (writeFileAtomic writes `wx` + mode 600, renames
// into place, then the provider stats the result).
// ---------------------------------------------------------------------------

const plainMode = (path: string): number => (fs.statSync(path) as VfsStats).mode & 0o777

fs.writeFileSync('/mwf/secrets.tmp', 'k: v\n', { mode: 0o600, flag: 'wx' })
fs.renameSync('/mwf/secrets.tmp', '/mwf/secrets.yaml')
check('a wx write with mode 600 stats as 600 after rename', plainMode('/mwf/secrets.yaml'), 0o600)
fs.writeFileSync('/mwf/secrets.yaml', 'k: w\n')
check('a rewrite keeps the creation bits', plainMode('/mwf/secrets.yaml'), 0o600)
const chmodHandle = await fsp.open('/mwf/secrets.yaml', 'r+')
await chmodHandle.chmod(0o640)
await chmodHandle.close()
check('FileHandle.chmod updates the opened file', plainMode('/mwf/secrets.yaml'), 0o640)
fs.chmodSync('/mwf/secrets.yaml', 0o640)
check('chmod reads back exactly what was set', plainMode('/mwf/secrets.yaml'), 0o640)
await fsp.chmod('/mwf/secrets.yaml', 0o600)
check('promises.chmod reads back through the bigint shape', Number(bigStats('/mwf/secrets.yaml').mode & 0o777n), 0o600)
fs.mkdirSync('/mwf/vault', { mode: 0o700 })
check('mkdir honours its mode option', plainMode('/mwf/vault'), 0o700)
check('promises.stat forwards the bigint option', typeof (await fsp.stat('/mwf/config', { bigint: true })).mode, 'bigint')

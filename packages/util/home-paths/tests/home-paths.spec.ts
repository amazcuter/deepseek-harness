import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_MWF_HOME_DISPLAY,
  MWF_HOME_DIR_NAME,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultMwfHome,
  mwfCachePath,
  mwfHomeDisplay,
  mwfHomePath,
  expandHomePath,
  resolveAgentsHome,
  resolveMwfHome,
} from '@metaworkflow/home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mwf path helpers', () => {
  it('owns the shared default MWF home directory name', () => {
    expect(MWF_HOME_DIR_NAME).toBe('.mwf')
    expect(DEFAULT_MWF_HOME_DISPLAY).toBe('~/.mwf')
    expect(defaultMwfHome()).toBe(join(homedir(), '.mwf'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.mwf')).toBe(join(homedir(), '.mwf'))
    expect(expandHomePath('~\\.mwf')).toBe(join(homedir(), '.mwf'))
    expect(expandHomePath('/tmp/.mwf')).toBe('/tmp/.mwf')
    expect(expandHomePath('~other/.mwf')).toBe('~other/.mwf')
  })

  it('resolves explicit path before MWF_HOME and the default', () => {
    const envHome = join(homedir(), 'env-mwf')

    expect(resolveMwfHome('/tmp/explicit-mwf', { MWF_HOME: '~/env-mwf' })).toBe(resolve('/tmp/explicit-mwf'))
    expect(resolveMwfHome(undefined, { MWF_HOME: '~/env-mwf' })).toBe(envHome)
    expect(resolveMwfHome(undefined, {})).toBe(defaultMwfHome())
  })

  it('treats an empty or whitespace-only MWF_HOME as unset', () => {
    expect(resolveMwfHome(undefined, { MWF_HOME: '' })).toBe(defaultMwfHome())
    expect(resolveMwfHome(undefined, { MWF_HOME: '   ' })).toBe(defaultMwfHome())
  })

  it('joins child segments onto the resolved MWF_HOME', () => {
    vi.stubEnv('MWF_HOME', '~/env-mwf')
    expect(mwfHomePath()).toBe(join(homedir(), 'env-mwf'))
    expect(mwfHomePath('storages', 'cache')).toBe(join(homedir(), 'env-mwf', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(mwfHomeDisplay(resolve(defaultMwfHome()))).toBe('~/.mwf')
    expect(mwfHomeDisplay('/some/other/root')).toBe('$MWF_HOME')
  })

  it('owns the shared default agents home directory name', () => {
    expect(AGENTS_HOME_DIR_NAME).toBe('.agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.agents'))
  })

  it('resolves an explicit agents home before MWF_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { MWF_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { MWF_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only MWF_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { MWF_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { MWF_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$MWF_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.mwf')],
    ['', join(homedir(), '.mwf')],
    ['   ', join(homedir(), '.mwf')],
    ['~/env-mwf', join(homedir(), 'env-mwf')],
    ['./relative-mwf', resolve('./relative-mwf')],
  ] as const)('resolves cache paths with MWF_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('MWF_HOME', home)
    try {
      expect(mwfCachePath()).toBe(join(expectedHome, 'cache'))
      expect(mwfCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('MWF_HOME', '~/env-mwf')
    try {
      expect(mwfCachePath({ mwfHome: '~/explicit-mwf' })).toBe(join(homedir(), 'explicit-mwf', 'cache'))
      expect(mwfCachePath({ mwfHome: './explicit-mwf' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-mwf/cache/attachments/request-images'))
      expect(mwfCachePath({}, 'attachments')).toBe(join(homedir(), 'env-mwf', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwf-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

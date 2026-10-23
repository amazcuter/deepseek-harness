/** Release family discovery, publish order, tag naming, and the bump judgements. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from '../client-build-environment.ts'
import { ON_DEMAND_BUNDLES } from '../../packages/boot/app-boot/src/official-bundles.ts'
import { releaseFamily, type ReleaseMember } from './families.ts'
import { compareVersions, nextVendorVersion, planShared, reachesPayload } from './bump.ts'

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mwf-release-build-'))
  roots.push(root)
  write(join(root, 'package.json'), `${JSON.stringify({ version: environment.MWF_CLIENT_VERSION ?? '0.0.1' })}\n`)
  write(join(root, 'apps/web/dist/index.html'), '<main></main>')
  write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(root, environment)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('release families', () => {
  it('publishes all current experimental packages', () => {
    const members = releaseFamily('mwf').members(resolve(import.meta.dirname, '../..'))

    expect(members
      .filter(member => member.directory.startsWith('packages/experimental/'))
      .map(member => member.name)).toEqual([
      '@metaworkflow/experimental-agent-team-profile',
      '@metaworkflow/experimental-agent-team',
      '@metaworkflow/experimental-api-speech-to-text',
      '@metaworkflow/experimental-auto-review',
      '@metaworkflow/experimental-badge-skill-bundle',
      '@metaworkflow/experimental-browser-use-chrome-devtools-mcp',
      '@metaworkflow/experimental-browser-use-playwright-mcp',
      '@metaworkflow/experimental-browser-use-runtime',
      '@metaworkflow/experimental-browser-use-stagehand-native',
      '@metaworkflow/experimental-claude-code-mods',
      '@metaworkflow/experimental-client-ui-agent-team',
      '@metaworkflow/experimental-client-ui-claude-code-mods',
      '@metaworkflow/experimental-client-ui-cot-translation',
      '@metaworkflow/experimental-client-ui-voice-input',
      '@metaworkflow/experimental-computer-use-cua-driver-mcp',
      '@metaworkflow/experimental-computer-use-cua-driver-native',
      '@metaworkflow/experimental-cot-translation-bundle',
      '@metaworkflow/experimental-cua-macos',
      '@metaworkflow/cua',
      '@metaworkflow/hook-protocol',
      '@metaworkflow/hooks-claude-code',
      '@metaworkflow/hooks-codex',
      '@metaworkflow/experimental-inspector-profile',
      '@metaworkflow/experimental-inspector',
      '@metaworkflow/experimental-plugin-market-bundle',
      '@metaworkflow/experimental-ptc-runtime-python',
      '@metaworkflow/experimental-ralph-bundle',
      '@metaworkflow/experimental-session-inspector',
      '@metaworkflow/experimental-session-search',
      '@metaworkflow/session-title-all-prompts-llm',
      '@metaworkflow/experimental-session-titles-bundle',
      '@metaworkflow/skill-badge',
      '@metaworkflow/experimental-speech-to-text-sensevoice',
      '@metaworkflow/experimental-speech-to-text',
      '@metaworkflow/experimental-terminal-bundle',
      '@metaworkflow/experimental-tool-agent-team',
      '@metaworkflow/tool-ralph',
      '@metaworkflow/tool-session-query',
      '@metaworkflow/tool-terminal',
      '@metaworkflow/experimental-tool-worktree',
      '@metaworkflow/experimental-translator',
      '@metaworkflow/experimental-voice-input-bundle',
      '@metaworkflow/webhook-github',
      '@metaworkflow/webhook',
      '@metaworkflow/experimental-webworker-packer',
      '@metaworkflow/experimental-webworker-runtime',
      '@metaworkflow/experimental-worktree',
    ])
  })

  it('excludes private applications from the publish set', () => {
    const root = mkdtempSync(join(tmpdir(), 'mwf-release-private-'))
    roots.push(root)
    write(join(root, 'apps/public/package.json'), '{"name":"@metaworkflow/public","version":"0.0.1"}\n')
    write(join(root, 'apps/private/package.json'), '{"name":"@metaworkflow/private","version":"0.0.1","private":true}\n')

    expect(releaseFamily('mwf').members(root).map(entry => entry.name)).toEqual(['@metaworkflow/public'])
  })

  it('publishes unlisted experimental packages while retaining private exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'mwf-release-experimental-'))
    roots.push(root)
    write(join(root, 'packages/experimental/prototype/package.json'), JSON.stringify({
      name: '@metaworkflow/experimental-prototype',
      version: '0.0.1',
      publishConfig: { access: 'public' },
    }))
    write(join(root, 'packages/experimental/inspector/package.json'), JSON.stringify({
      name: '@metaworkflow/experimental-inspector',
      version: '0.0.1',
      private: true,
    }))

    expect(releaseFamily('mwf').members(root).map(entry => entry.name)).toEqual([
      '@metaworkflow/experimental-prototype',
    ])
  })

  it('bumps private mwf workspaces without adding release tags', () => {
    const root = mkdtempSync(join(tmpdir(), 'mwf-release-version-'))
    roots.push(root)
    write(join(root, 'package.json'), '{"version":"0.0.1"}\n')
    write(join(root, 'apps/desktop/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/experimental/prototype/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/core/unselected/package.json'), '{"version":"0.0.1"}\n')

    const mwf = releaseFamily('mwf')
    const published = member('packages/core/published', '@metaworkflow/published')
    const { planned } = planShared(mwf, root, [published], '0.0.2')

    expect(planned.map(entry => ({ path: entry.manifestPath, tag: entry.tag }))).toEqual([
      { path: 'package.json', tag: undefined },
      { path: 'packages/core/published/package.json', tag: 'mwf-v0.0.2' },
      { path: 'apps/desktop/package.json', tag: undefined },
      { path: 'packages/experimental/prototype/package.json', tag: undefined },
    ])
  })

  it.each(['0.0.2-alpha.1', '0.0.2-canary.1', '0.0.2-rc.1'])(
    'accepts the explicit mwf prerelease version %s',
    (version) => {
      const root = mkdtempSync(join(tmpdir(), 'mwf-release-prerelease-'))
      roots.push(root)
      write(join(root, 'package.json'), '{"version":"0.0.1"}\n')

      const mwf = releaseFamily('mwf')
      const published = member('packages/core/published', '@metaworkflow/published')
      const plan = planShared(mwf, root, [published], version)

      expect(plan.version).toBe(version)
      expect(plan.planned[1]?.tag).toBe(`mwf-v${version}`)
    },
  )

  it('names one tag for the whole mwf family and one per vendored package', () => {
    const mwf = releaseFamily('mwf')
    const vendor = releaseFamily('vendor')
    const cli = member('apps/cli', '@metaworkflow/cli')
    const cordis = { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' }

    expect(mwf.tagFor(cli)).toBe('mwf-v0.0.1')
    expect(vendor.tagFor(cordis)).toBe('vendor-cordis-v4.0.1')
    // The prefix is constructed, not recovered from a tag: a version with a
    // hyphen would defeat any suffix-stripping.
    expect(vendor.tagPrefixFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v')
    expect(vendor.tagFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v4.0.0-rc.7')
  })

  it('assigns alpha and canary dist-tags only to mwf releases', () => {
    const mwf = releaseFamily('mwf')
    const vendor = releaseFamily('vendor')

    expect(mwf.distTagForVersion('0.0.2-alpha.1')).toBe('alpha')
    expect(mwf.distTagForVersion('0.0.2-canary.1')).toBe('canary')
    expect(mwf.distTagForVersion('0.0.2-rc.1')).toBe('next')
    expect(mwf.distTagForVersion('0.0.2')).toBeUndefined()
    expect(vendor.distTagForVersion('4.0.1-alpha.1')).toBe('next')
    expect(vendor.distTagForVersion('4.0.1-canary.1')).toBe('next')
  })

  it('rejects a family whose members disagree on the shared version', () => {
    const mwf = releaseFamily('mwf')
    const members = [member('apps/cli', '@metaworkflow/cli'), { ...member('apps/web', '@metaworkflow/web-frontend'), version: '0.0.2' }]

    expect(() => { mwf.verifyVersions(members) }).toThrow(/must share one version/)
    expect(() => { mwf.verifyVersions([members[0]!]) }).not.toThrow()
  })

  it('accepts independent vendored versions and rejects an unpublishable one', () => {
    const vendor = releaseFamily('vendor')
    const members = [
      { ...member('vendor/cordis', '@deepseek-ai/cordis'), version: '4.0.1' },
      { ...member('vendor/cosmokit', '@deepseek-ai/cosmokit'), version: '1.8.2' },
    ]

    expect(() => { vendor.verifyVersions(members) }).not.toThrow()
    expect(() => { vendor.verifyVersions([{ ...members[0]!, version: 'latest' }]) }).toThrow(/unpublishable version/)
  })

  it('requires a current official client build only for mwf artifacts', () => {
    const mwf = releaseFamily('mwf')
    const vendor = releaseFamily('vendor')
    const officialEnvironment = officialClientBuildEnvironment(resolve(import.meta.dirname, '../..'))
    vi.stubEnv('MWF_CLIENT_COMMIT_HASH', officialEnvironment.MWF_CLIENT_COMMIT_HASH)
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})
    const missing = join(defaultBuild, 'missing')
    write(join(missing, 'package.json'), `${JSON.stringify({ version: officialEnvironment.MWF_CLIENT_VERSION })}\n`)

    expect(() => { mwf.verifyBuildArtifacts(official) }).not.toThrow()
    expect(() => { mwf.verifyBuildArtifacts(defaultBuild) }).toThrow(/MWF_CLIENT_TITLE/)
    expect(() => { mwf.verifyBuildArtifacts(missing) }).toThrow(/record.*missing/)
    expect(() => { vendor.verifyBuildArtifacts(missing) }).not.toThrow()

    write(join(official, 'packages/client/example/lib/client.js'), 'module.exports = { changed: true }\n')
    expect(() => { mwf.verifyBuildArtifacts(official) }).toThrow(/artifacts differ/)
  })

  it('publishes a dependency before its consumer, and orders ties by name', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/consumer', '@metaworkflow/consumer', { dependencies: { '@metaworkflow/library': 'workspace:^' } }),
      member('packages/a/library', '@metaworkflow/library'),
      member('packages/a/zebra', '@metaworkflow/zebra'),
    ]

    expect(mwf.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@metaworkflow/library',
      '@metaworkflow/consumer',
      '@metaworkflow/zebra',
    ])
  })

  it('publishes on-demand catalog members before mwf without adding installed dependencies', () => {
    const mwf = member('apps/cli', '@metaworkflow/cli')
    const providers = ON_DEMAND_BUNDLES.map(name => member(`packages/subagent/${name}`, name))
    const plan = releaseFamily('mwf').publishOrder([mwf, ...providers])
    expect(plan.order.map(entry => entry.name)).toEqual([...ON_DEMAND_BUNDLES, mwf.name])
    expect(mwf.manifest).toEqual({})
    expect(plan.droppedPeerEdges).toEqual([])
  })

  it('rejects an advertised provider missing from the public release family', () => {
    expect(() => releaseFamily('mwf').publishOrder([member('apps/cli', '@metaworkflow/cli')]))
      .toThrow('Official catalog prerequisite')
  })

  it('keeps catalog prerequisites ahead of a mwf peer declaration', () => {
    const mwf = member('apps/cli', '@metaworkflow/cli')
    const providers = ON_DEMAND_BUNDLES.map(name => member(`packages/subagent/${name}`, name, {
      peerDependencies: { '@metaworkflow/cli': 'workspace:*' },
    }))
    const plan = releaseFamily('mwf').publishOrder([mwf, ...providers])
    expect(plan.order.map(entry => entry.name)).toEqual([...ON_DEMAND_BUNDLES, mwf.name])
    expect(plan.droppedPeerEdges).toEqual(ON_DEMAND_BUNDLES.map(name => ({ consumer: name, peer: mwf.name })))
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'requires exact packed MWF %s while preserving external ranges', (section) => {
      const pkg = member('packages/example/provider', '@metaworkflow/provider')
      const family = releaseFamily('mwf')
      const manifest = { name: pkg.name, version: pkg.version, [section]: { '@metaworkflow/tools': pkg.version, external: '^4.0.0' } }
      expect(() => { family.validatePackedManifest(pkg, manifest) }).not.toThrow()
      for (const range of ['workspace:*', '^0.0.1', '~0.0.1', '0.0.2', '*']) {
        expect(() => { family.validatePackedManifest(pkg, { ...manifest, [section]: { '@metaworkflow/tools': range } }) })
          .toThrow(`packed ${section}.@metaworkflow/tools must equal`)
      }
    },
  )

  it('checks packed identities and preserves independent vendor versions', () => {
    const pkg = member('vendor/example', '@deepseek-ai/example')
    const family = releaseFamily('vendor')
    expect(() => { family.validatePackedManifest(pkg, { name: pkg.name, version: pkg.version, dependencies: { '@metaworkflow/tools': '^4.0.0' } }) })
      .not.toThrow()
    expect(() => { family.validatePackedManifest(pkg, { name: '@deepseek-ai/other', version: pkg.version }) }).toThrow('packed identity')
    expect(() => { family.validatePackedManifest(pkg, { name: pkg.name, version: '0.0.2' }) }).toThrow('packed identity')
  })

  it('reports a runtime dependency cycle instead of emitting an arbitrary order', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/left', '@metaworkflow/left', { dependencies: { '@metaworkflow/right': 'workspace:^' } }),
      member('packages/a/right', '@metaworkflow/right', { dependencies: { '@metaworkflow/left': 'workspace:^' } }),
    ]

    expect(() => { mwf.publishOrder(members) }).toThrow(/dependency cycle/)
  })

  it('publishes a peer before its consumer', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/consumer', '@metaworkflow/consumer', { peerDependencies: { '@metaworkflow/zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@metaworkflow/zebra'),
    ]

    // Name order alone would place the consumer first; the peer edge moves it.
    expect(mwf.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@metaworkflow/zebra',
      '@metaworkflow/consumer',
    ])
  })

  it('orders around a peer cycle rather than refusing to publish, and reports the edge it dropped', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/left', '@metaworkflow/left', { peerDependencies: { '@metaworkflow/right': 'workspace:^' } }),
      member('packages/a/right', '@metaworkflow/right', { peerDependencies: { '@metaworkflow/left': 'workspace:^' } }),
    ]

    // Sibling packages declare each other as peers, and npm treats an unmet peer
    // as a warning, so this pair has to publish rather than fail the release.
    const plan = mwf.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@metaworkflow/right',
      '@metaworkflow/left',
    ])
    // One of the two edges has to give, and which one it is belongs in the log.
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@metaworkflow/right', peer: '@metaworkflow/left' },
    ])
  })

  it('honours an install edge even when a peer cycle surrounds it', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/base', '@metaworkflow/base', { peerDependencies: { '@metaworkflow/consumer': 'workspace:^' } }),
      member('packages/a/consumer', '@metaworkflow/consumer', {
        dependencies: { '@metaworkflow/base': 'workspace:^' },
        peerDependencies: { '@metaworkflow/base': 'workspace:^' },
      }),
    ]

    // The install edge is absolute: base publishes first, and the peer edge that
    // would reverse it is the one dropped.
    const plan = mwf.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@metaworkflow/base',
      '@metaworkflow/consumer',
    ])
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@metaworkflow/base', peer: '@metaworkflow/consumer' },
    ])
  })

  it('refuses an order that would publish a consumer before a dependency it installs', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/alpha', '@metaworkflow/alpha', { peerDependencies: { '@metaworkflow/bravo': 'workspace:^' } }),
      member('packages/a/bravo', '@metaworkflow/bravo', { peerDependencies: { '@metaworkflow/charlie': 'workspace:^' } }),
      member('packages/a/charlie', '@metaworkflow/charlie', { dependencies: { '@metaworkflow/alpha': 'workspace:^' } }),
    ]

    // A cycle of two peer edges closed by one install edge: dropping a peer edge
    // would order this, and the traversal drops the install edge instead. That
    // order would publish charlie before the alpha it installs, so it is refused
    // here rather than published.
    expect(() => { mwf.publishOrder(members) }).toThrow(/no publish order honours @metaworkflow\/charlie -> @metaworkflow\/alpha/)
  })

  it('ignores devDependencies when ordering', () => {
    const mwf = releaseFamily('mwf')
    const members = [
      member('packages/a/alpha', '@metaworkflow/alpha', { devDependencies: { '@metaworkflow/zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@metaworkflow/zebra'),
    ]

    // A dev dependency is absent from the published package, so it must not move
    // the consumer behind it.
    expect(mwf.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@metaworkflow/alpha',
      '@metaworkflow/zebra',
    ])
  })

  it('applies the harness payload policy to mwf and keeps upstream payloads for vendored packages', () => {
    const mwf = releaseFamily('mwf')
    const vendor = releaseFamily('vendor')
    const harness = member('packages/a/library', '@metaworkflow/library')
    const vendored = member('vendor/cordis', '@deepseek-ai/cordis')

    expect(() => { mwf.validatePayload(harness, ['package/lib/index.js', 'package/src/index.ts']) })
      .toThrow(/publishes source file/)
    expect(() => { vendor.validatePayload(vendored, ['package/lib/index.js', 'package/src/index.ts']) }).not.toThrow()
    expect(() => { vendor.validatePayload(vendored, []) }).toThrow(/empty tarball/)
  })

  it('drives the installed entry only for the family that publishes one', () => {
    expect(releaseFamily('mwf').installedEntry).toEqual({ packageName: '@metaworkflow/cli', binPath: 'lib/bin.js' })
    expect(releaseFamily('vendor').installedEntry).toBeUndefined()
  })

  it('rejects an unknown family identifier', () => {
    expect(() => { releaseFamily('native') }).toThrow(/unknown release family/)
  })
})

describe('vendored version baseline', () => {
  it('drops an upstream prerelease segment and increments the patch', () => {
    expect(nextVendorVersion('4.0.0-rc.7', undefined)).toBe('4.0.1')
    expect(nextVendorVersion('1.0.0-rc.5', undefined)).toBe('1.0.1')
    expect(nextVendorVersion('1.8.1', undefined)).toBe('1.8.2')
  })

  it('increments from the last published version when a re-sync restored a lower one', () => {
    // Upstream moved rc.7 -> rc.8 after this repository published 4.0.1;
    // incrementing the manifest alone would name 4.0.1 a second time.
    expect(nextVendorVersion('4.0.0-rc.8', '4.0.1')).toBe('4.0.2')
    expect(nextVendorVersion('4.1.0', '4.0.1')).toBe('4.1.1')
  })

  it('appends a rehearsal prerelease without consuming its release numbers', () => {
    // A rehearsal burns 4.0.1-rc.1 and leaves 4.0.1 free, so the stable release
    // that follows takes those same numbers instead of skipping to 4.0.2.
    expect(nextVendorVersion('4.0.0-rc.7', undefined, 'rc.1')).toBe('4.0.1-rc.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1', 'rc.2')).toBe('4.0.1-rc.2')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1')).toBe('4.0.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1')).toBe('4.0.2')
  })
})

describe('version precedence', () => {
  it('orders alpha, canary, and release-candidate versions by semver precedence', () => {
    expect(compareVersions('4.0.1-alpha.1', '4.0.1-canary.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-canary.1', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('ranks a release above the prerelease it follows', () => {
    // git --sort=v:refname disagrees, placing 4.0.1-rc.1 above 4.0.1, which is
    // why the newest published version is chosen here rather than by git.
    expect(compareVersions('4.0.1', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('compares numeric prerelease fields numerically', () => {
    expect(compareVersions('4.0.1-rc.10', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.2', '4.0.1-rc.10')).toBeLessThan(0)
  })

  it('ranks a numeric field below an alphanumeric one, and a shorter list below a longer', () => {
    expect(compareVersions('4.0.1-1', '4.0.1-alpha')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.2', '4.0.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1-rc.1')).toBe(0)
  })
})

describe('payload change judgement', () => {
  const sourceShipping = member('vendor/cosmokit', '@deepseek-ai/cosmokit', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'src'],
  })
  const buildOutputOnly = member('vendor/cordis', '@deepseek-ai/cordis', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'bin.js'],
  })

  it('counts the manifest and the files npm always publishes', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/package.json')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.md')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/src/index.ts')).toBe(true)
  })

  it('counts build inputs for a package whose payload is build output', () => {
    // cordis publishes lib/ only, and lib/ is not tracked: without this, a real
    // source change reads as "nothing changed" and the next publish fails on a
    // version whose bytes moved.
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/src/context.ts')).toBe(true)
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/tsconfig.json')).toBe(true)
  })

  it('ignores paths no tarball carries', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/tests/unit.spec.ts')).toBe(false)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/CHANGELOG.md')).toBe(false)
    // The README pattern is deliberately loose: over-reporting a change costs one
    // unnecessary patch bump, while under-reporting fails the next publish on a
    // version whose bytes moved.
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.i18n.yaml')).toBe(true)
    expect(reachesPayload(member('packages/a/library', '@metaworkflow/library', { files: ['lib/index.js'] }),
      'packages/a/library/tests/library.spec.ts')).toBe(false)
  })
})

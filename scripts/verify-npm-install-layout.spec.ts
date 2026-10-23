import { describe, expect, it } from 'vitest'
import type { NpmPackageLock, RegistryIndex } from './benchmark-npm-resolution.ts'
import {
  assertDualMwfInstallLayout,
  assertResolutionWorkBudget,
  buildDualMwfRegistry,
  MAX_RESOLUTION_WORK_UNITS,
} from './verify-npm-install-layout.ts'

function validLayout(): NpmPackageLock {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@metaworkflow/cli': '0.2.0', 'mwf-previous': 'npm:@metaworkflow/cli@0.1.0' } },
      'node_modules/@deepseek-ai/cordis': { version: '4.0.1' },
      'node_modules/@metaworkflow/cli': {
        version: '0.2.0',
        dependencies: { '@metaworkflow/child': '^0.2.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      },
      'node_modules/@metaworkflow/child': {
        version: '0.2.0',
        dependencies: { '@metaworkflow/leaf': '^0.2.0' },
      },
      'node_modules/@metaworkflow/leaf': { version: '0.2.0' },
      'node_modules/mwf-previous': {
        name: '@metaworkflow/cli',
        version: '0.1.0',
        dependencies: { '@metaworkflow/child': '^0.1.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      },
      'node_modules/mwf-previous/node_modules/@metaworkflow/child': {
        version: '0.1.0',
        dependencies: { '@metaworkflow/leaf': '^0.1.0' },
      },
      'node_modules/mwf-previous/node_modules/@metaworkflow/leaf': { version: '0.1.0' },
    },
  }
}

describe('npm install layout verifier', () => {
  it('creates two incompatible versions of every MWF package', () => {
    const index: RegistryIndex = new Map([
      ['@metaworkflow/cli', new Map([['0.1.1-rc.2', {
        name: '@metaworkflow/cli',
        version: '0.1.1-rc.2',
        dependencies: { '@metaworkflow/child': '^0.1.1-rc.2' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      }]])],
      ['@metaworkflow/child', new Map([['0.1.1-rc.2', {
        name: '@metaworkflow/child',
        version: '0.1.1-rc.2',
      }]])],
      ['@deepseek-ai/cordis', new Map([['4.0.1', {
        name: '@deepseek-ai/cordis',
        version: '4.0.1',
      }]])],
    ])

    const dual = buildDualMwfRegistry(index, '0.1.1-rc.2')

    expect([...dual.get('@metaworkflow/cli')?.keys() ?? []]).toEqual(['0.1.0', '0.2.0'])
    expect(dual.get('@metaworkflow/cli')?.get('0.1.0')).toMatchObject({
      version: '0.1.0',
      dependencies: { '@metaworkflow/child': '^0.1.0' },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    })
    expect(dual.get('@metaworkflow/cli')?.get('0.2.0')).toMatchObject({
      version: '0.2.0',
      dependencies: { '@metaworkflow/child': '^0.2.0' },
    })
    expect(dual.get('@deepseek-ai/cordis')).toBe(index.get('@deepseek-ai/cordis'))
  })

  it('accepts isolated MWF releases with one shared Cordis installation', () => {
    expect(assertDualMwfInstallLayout(validLayout())).toEqual({
      mwfPackagesPerVersion: 3,
      checkedMwfEdges: 4,
    })
  })

  it.each([
    ['react', 'node_modules/react'],
    ['react-dom', 'node_modules/react-dom'],
    ['react', 'node_modules/mwf-previous/node_modules/react'],
    ['react-dom', 'node_modules/mwf-previous/node_modules/react-dom'],
  ])('rejects browser runtime %s installed at %s in the MWF-only consumer', (name, path) => {
    const layout = validLayout()
    const packages = { ...layout.packages, [path]: { version: '18.3.1' } }
    expect(() => assertDualMwfInstallLayout({ ...layout, packages })).toThrow(
      `${path}: ${name} is a browser build input`,
    )
  })

  it('rejects an internal edge that crosses release versions', () => {
    const layout = validLayout()
    const packages = { ...layout.packages }
    Reflect.deleteProperty(packages, 'node_modules/mwf-previous/node_modules/@metaworkflow/leaf')

    expect(() => assertDualMwfInstallLayout({ ...layout, packages })).toThrow(
      'node_modules/mwf-previous/node_modules/@metaworkflow/child: dependencies '
      + '@metaworkflow/leaf resolves to node_modules/@metaworkflow/leaf@0.2.0, expected 0.1.0',
    )
  })

  it('rejects a second Cordis installation', () => {
    const layout = validLayout()
    const packages = {
      ...layout.packages,
      'node_modules/mwf-previous/node_modules/@deepseek-ai/cordis': { version: '4.0.1' },
    }

    expect(() => assertDualMwfInstallLayout({ ...layout, packages })).toThrow(
      'expected one shared @deepseek-ai/cordis',
    )
  })
})

describe('resolution work budget', () => {
  it('accepts the measured dual-release graph', () => {
    expect(assertResolutionWorkBudget({ mwfPackagesPerVersion: 277, checkedMwfEdges: 2524 }))
      .toBe(699_148)
  })

  it('accepts a graph exactly at the budget and rejects one internal edge above it', () => {
    const packages = 350
    const edgesAtBudget = Math.floor(MAX_RESOLUTION_WORK_UNITS / packages)

    expect(packages * edgesAtBudget).toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(assertResolutionWorkBudget({ mwfPackagesPerVersion: packages, checkedMwfEdges: edgesAtBudget }))
      .toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(() => assertResolutionWorkBudget({
      mwfPackagesPerVersion: packages,
      checkedMwfEdges: edgesAtBudget + 1,
    })).toThrow(`= ${String(MAX_RESOLUTION_WORK_UNITS + packages)} unit(s), budget ${String(MAX_RESOLUTION_WORK_UNITS)} unit(s)`)
  })

  it('accepts the headroom and rejects a runaway graph with its own measured counts', () => {
    expect(assertResolutionWorkBudget({ mwfPackagesPerVersion: 300, checkedMwfEdges: 2800 }))
      .toBe(840_000)
    expect(() => assertResolutionWorkBudget({ mwfPackagesPerVersion: 400, checkedMwfEdges: 3000 }))
      .toThrow('400 package(s) per release x 3000 internal edge(s) = 1200000 unit(s), budget 875000 unit(s)')
  })
})

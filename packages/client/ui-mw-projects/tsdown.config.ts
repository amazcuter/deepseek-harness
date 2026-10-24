import { createRequire } from 'node:module'
import { Rolldown, type UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

const require = createRequire(import.meta.url)

/** The specifier this package imports and the virtual module that answers it. */
const MERMAID_SPECIFIER = 'mermaid'
// The chunk file keeps this name after `client.`, so it must start with a
// letter: the Client module loader only serves `client.<name>.js` factories.
const MERMAID_MODULE = '\0mermaid-bundle'

/**
 * Bundle Mermaid into one self-contained module.
 *
 * Mermaid lazy-loads one renderer per diagram type, and its own build spreads
 * those over sibling chunks that share code through synchronous requires. The
 * Client module loader materializes exactly the chunk a factory requests, so a
 * cross-chunk require has no table entry and fails at runtime. Bundling Mermaid
 * here — dynamic imports inlined — leaves this package's `import('mermaid')` as
 * the single lazy boundary the loader can serve.
 */
const mermaidBundle: NonNullable<UserConfig['plugins']> = [{
  name: 'mwf-mermaid-bundle',
  resolveId(source: string) {
    return source === MERMAID_SPECIFIER ? MERMAID_MODULE : null
  },
  async load(id: string) {
    if (id !== MERMAID_MODULE) return null
    const parent = this
    const build = await Rolldown.rolldown({
      input: require.resolve(MERMAID_SPECIFIER),
      platform: 'browser',
      resolve: { mainFields: ['browser', 'module', 'main'], aliasFields: [['browser']] },
      transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
    })
    try {
      const result = await build.generate({ format: 'esm', minify: true, inlineDynamicImports: true })
      const chunk = result.output[0]
      if (chunk === undefined || chunk.type !== 'chunk') throw new Error('Mermaid did not emit a JavaScript chunk')
      for (const path of Object.keys(chunk.modules)) parent.addWatchFile(path)
      return chunk.code
    } finally {
      await build.close()
    }
  },
}]

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])

/** @param options - the build-face selector the tsdown runner passes. */
export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true
    ? {
      ...config,
      plugins: [...(config.plugins ?? []), mermaidBundle],
      outputOptions: {
        ...config.outputOptions,
        // A virtual module's id starts with NUL, which the chunk name would keep
        // as a leading underscore; the loader only serves `client.<name>.js`.
        advancedChunks: { groups: [{ name: 'mermaid', test: MERMAID_MODULE }] },
      },
    }
    : config)

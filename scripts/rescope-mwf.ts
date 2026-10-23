/**
 * Rename the DeepSeek Harness `dsh` identity to MetaWorkFlow `mwf` /
 * `@metaworkflow`, and undo that rename with `--reverse`.
 *
 * Stage plan — this script owns stage 0 only:
 *
 * 1. **Stage 0 — text and manifest rewrite (this file).** One ordered pass over
 *    every tracked text file, including the `package.json` `name`, `bin`, and
 *    `dsh` metadata fields. No file or directory is moved: the 349 workspace
 *    directories already carry no `dsh` prefix, so only manifest names and
 *    import specifiers change. Every reference to a path that does contain
 *    `dsh` is preserved verbatim ({@link derivedPreservedSegments}) so no link
 *    points at a name the pass did not create.
 * 2. **Stage 1 — `pnpm install`.** Regenerates `pnpm-lock.yaml`, skipped here
 *    because a mechanical rewrite would desynchronise the resolution graph.
 * 3. **Stage 2 — generators.** `*.i18n.yaml` blob records, the third-party
 *    notices, and the dependency/agent-note catalogs are recomputed rather than
 *    rewritten; the script skips them and every skipped generated file names the
 *    command that owns it in {@link isRescopeExcluded}.
 * 4. **Stage 3 — review.** {@link MANIFEST_READERS} lists every site that reads
 *    the `package.json` `dsh` metadata block; stage 0 renames each to `mwf`
 *    outright, with no dual read. {@link MOVING_SEGMENTS} lists the tracked
 *    paths whose own names carry `dsh` and therefore need a `git mv` in a later
 *    stage, and {@link PRESERVED_SKILLS} stays `dsh-*` until the user confirms.
 *
 * Lowercase matching is anchored on a token boundary — `dsh` not preceded by an
 * ASCII letter or digit — so `handshake`, `spreadsheet`, and the `\x07dsh`
 * escape stay untouched while `.dsh`, `--dsh-*`, `dsh_home`, and `x-dsh-token`
 * fold into their `mwf` forms. `Dsh` and `DSH` match without that guard because
 * every embedded occurrence in this tree is a camel-case identifier
 * (`resolveDshHome`, `isDSHRemoteError`) or an escape-adjacent constant
 * (`\nDSH_CRED_TEST`); no prose word carries them. Longer, more specific rules
 * run before the generic token rules so each mapping keeps an isolated count.
 *
 * Must not match (see {@link derivedPreservedSegments}, {@link PRESERVED_LITERALS},
 * {@link PRESERVED_PATTERNS}, and {@link isRescopeExcluded}):
 *
 * - `.agents/notes/archived/**` (frozen records), `vendor/**`, licence text,
 *   `THIRD_PARTY_NOTICES.md`
 * - the `deepseek-harness` repository name, upstream URLs, and pinned SHAs
 * - the Python distributions `deepseek-harness-sdk`, `deepseek_harness`,
 *   `deepseek-harness-runtime-bin`, `deepseek_harness_runtime` — none carries a
 *   `dsh` token, so only their `dsh` executable references change
 * - `dsh-libreoffice-kit`, `.agents/skills/dsh-*` and every other tracked path
 *   name containing `dsh`, `@local/dsh-*` templates, the `.agents` directory
 * - `node_modules`, `.git`, `pnpm-lock.yaml`, `*.i18n.yaml`, `scripts/snapshots/**`
 *
 * Usage: `npx tsx scripts/rescope-mwf.ts [--check|--apply|--list] [--reverse]
 * [--preview <path>]`. `--check` reports the diff counts and exits non-zero
 * while any pre-rename token remains; `--apply` writes; `--list` also prints the
 * stage-3 review lists; `--preview` prints one file's line diff. `--reverse`
 * mirrors each rule against the post-rename text, which restores the mapping
 * mechanically but is only meaningful on an applied tree: the scope and prefix
 * rules lose the information that tells a CLI package from a renamed one. No
 * mode writes unless `--apply` is given, and `--apply` is idempotent: every run
 * rewrites its own output once more and fails if that changes anything, so a
 * second `--apply` writes nothing.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** This file carries the mapping, so rewriting it would rewrite the rules themselves. */
const SCRIPT_FILE = 'scripts/rescope-mwf.ts'

/** One ordered rewrite: the forward form, its mirror, and the count that pins it. */
interface Rule {
  /** Stable id used in the report and in the assertion list. */
  readonly id: string
  /** Mapping stage the rule belongs to; see the module comment. */
  readonly stage: 1 | 2 | 3
  /** One-line description of what the rule rewrites. */
  readonly summary: string
  /** Source form and its replacement. */
  readonly forward: readonly [RegExp, string]
  /** Mirror form used by `--reverse`, written against the post-rename text. */
  readonly reverse: readonly [RegExp, string]
  /**
   * Occurrences one complete forward application consumes across the scanned
   * corpus. A run is valid when a rule measures either this count (the tree is
   * pre-rename for that rule) or zero (the rule has landed); anything else means
   * the source moved and fails the run instead of renaming half a site.
   */
  readonly expect: number
}

/**
 * The mapping, longest and most specific first. The final two rules are the
 * catch-all token renames, so every earlier rule keeps an isolated count.
 */
const RULES: readonly Rule[] = [
  {
    id: 'boot-inject-contract',
    stage: 3,
    summary: 'window.__DSH_BOOT__ injection contract',
    forward: [/__DSH_BOOT__/g, '__MWF_BOOT__'],
    reverse: [/__MWF_BOOT__/g, '__DSH_BOOT__'],
    expect: 89,
  },
  {
    id: 'transport-contract',
    stage: 3,
    summary: 'window.__DSH_TRANSPORT__ bridge contract',
    forward: [/__DSH_TRANSPORT__/g, '__MWF_TRANSPORT__'],
    reverse: [/__MWF_TRANSPORT__/g, '__DSH_TRANSPORT__'],
    expect: 68,
  },
  {
    id: 'main-contract',
    stage: 1,
    summary: 'electron-host __dsh_main__ entrypoint symbol',
    forward: [/__dsh_main__/g, '__mwf_main__'],
    reverse: [/__mwf_main__/g, '__dsh_main__'],
    expect: 20,
  },
  {
    id: 'home-dir-constant',
    stage: 1,
    summary: 'DSH_HOME_DIR_NAME constant',
    forward: [/DSH_HOME_DIR_NAME/g, 'MWF_HOME_DIR_NAME'],
    reverse: [/MWF_HOME_DIR_NAME/g, 'DSH_HOME_DIR_NAME'],
    expect: 5,
  },
  {
    // Ahead of the generic scope rule, which would otherwise produce
    // `@metaworkflow/metaworkflow-app`. The directory keeps its name.
    id: 'metaworkflow-app',
    stage: 1,
    summary: '@deepseek-ai/dsh-metaworkflow-app -> @metaworkflow/app',
    forward: [/@deepseek-ai\/dsh-metaworkflow-app(?![-\w])/g, '@metaworkflow/app'],
    reverse: [/@metaworkflow\/app(?![-\w])/g, '@deepseek-ai/dsh-metaworkflow-app'],
    expect: 11,
  },
  {
    id: 'scoped-package',
    stage: 1,
    summary: '@deepseek-ai/dsh-<name> -> @metaworkflow/<name>',
    forward: [/@deepseek-ai\/dsh-/g, '@metaworkflow/'],
    // `app` and `cli` are excluded so `--reverse` restores their specific names
    // even though the reversed rule order reaches this generic rule first.
    reverse: [/@metaworkflow\/(?!app(?![-\w])|cli(?![-\w]))/g, '@deepseek-ai/dsh-'],
    expect: 28555,
  },
  {
    id: 'cli-package',
    stage: 1,
    summary: '@deepseek-ai/dsh (apps/cli) -> @metaworkflow/cli',
    forward: [/@deepseek-ai\/dsh(?![-\w])/g, '@metaworkflow/cli'],
    reverse: [/@metaworkflow\/cli(?![-\w])/g, '@deepseek-ai/dsh'],
    expect: 274,
  },
  {
    id: 'manifest-key',
    stage: 3,
    summary: 'the quoted "dsh" metadata key and bin name',
    forward: [/(["'])dsh\1/g, '$1mwf$1'],
    reverse: [/(["'])mwf\1/g, '$1dsh$1'],
    expect: 384,
  },
  {
    id: 'home-path-identifier',
    stage: 1,
    summary: 'dshHomePath -> mwfHomePath',
    forward: [/dshHomePath/g, 'mwfHomePath'],
    reverse: [/mwfHomePath/g, 'dshHomePath'],
    expect: 163,
  },
  {
    id: 'home-identifier',
    stage: 1,
    summary: 'dshHome -> mwfHome (and its derived names)',
    forward: [/dshHome/g, 'mwfHome'],
    reverse: [/mwfHome/g, 'dshHome'],
    expect: 303,
  },
  {
    id: 'runtime-directory',
    stage: 1,
    summary: 'dsh-runtimes -> mwf-runtimes',
    forward: [/dsh-runtimes/g, 'mwf-runtimes'],
    reverse: [/mwf-runtimes/g, 'dsh-runtimes'],
    expect: 9,
  },
  {
    id: 'workspace-code',
    stage: 1,
    summary: '--dsh-workspace-- plugin coding -> --mwf-workspace--',
    forward: [/--dsh-workspace--/g, '--mwf-workspace--'],
    reverse: [/--mwf-workspace--/g, '--dsh-workspace--'],
    expect: 9,
  },
  {
    id: 'module-fallback-dir',
    stage: 1,
    summary: '.dsh-module-fallback profile projection directory',
    forward: [/dsh-module-fallback/g, 'mwf-module-fallback'],
    reverse: [/mwf-module-fallback/g, 'dsh-module-fallback'],
    expect: 27,
  },
  {
    id: 'home-directory',
    stage: 1,
    summary: 'the .dsh home directory -> .mwf',
    forward: [/\.dsh(?![A-Za-z0-9])/g, '.mwf'],
    reverse: [/\.mwf(?![A-Za-z0-9])/g, '.dsh'],
    expect: 984,
  },
  {
    id: 'env-prefix',
    stage: 1,
    summary: 'DSH_ environment variable prefix -> MWF_',
    forward: [/DSH_/g, 'MWF_'],
    reverse: [/MWF_/g, 'DSH_'],
    expect: 4769,
  },
  {
    id: 'type-identifier',
    stage: 1,
    summary: 'Dsh<Type> identifiers -> Mwf<Type>',
    forward: [/Dsh/g, 'Mwf'],
    reverse: [/Mwf/g, 'Dsh'],
    expect: 481,
  },
  {
    id: 'token-lowercase',
    stage: 1,
    summary: 'remaining lowercase dsh tokens (bin, paths, prose)',
    forward: [/(?<![A-Za-z0-9])dsh/g, 'mwf'],
    reverse: [/(?<![A-Za-z0-9])mwf/g, 'dsh'],
    expect: 14001,
  },
  {
    id: 'token-uppercase',
    stage: 1,
    summary: 'remaining uppercase DSH tokens (prose, constants)',
    forward: [/DSH/g, 'MWF'],
    reverse: [/MWF/g, 'DSH'],
    expect: 3860,
  },
]

/**
 * Mappings no token rule can express, recorded so the next stage does not
 * rediscover them. They carry no hit count because the script never rewrites
 * them.
 */
const DEFERRED_RULES: readonly string[] = [
  'brand: `MetaWorkFlow` replaces user-facing prose only where a human edits it; the `deepseek-harness` repository name, upstream URLs, and pinned SHAs stay verbatim.',
  'skills: `.agents/skills/dsh-*` directory names and every reference to them stay `dsh-*` until the user confirms the rename (see PRESERVED_SKILLS).',
  'brand probe: `docs/upgrade-guide/dsh-v*/` release directories keep their published names, so upgrade-guide links survive this pass.',
]

/**
 * Sites that read the `package.json` `dsh` metadata block. Stage 0 renames each
 * to `mwf` outright — there is no dual read — so this list is the review
 * checklist for that change, grouped by owning surface.
 */
const MANIFEST_READERS: readonly string[] = [
  // Manifest declarations.
  'packages/util/package-manifest/src/types.ts',
  // Profile composition and bundle resolution.
  'packages/boot/app-boot/src/profile.ts',
  'packages/boot/app-boot/src/profile-plugins.ts',
  'packages/boot/app-boot/src/plugin-compatibility.ts',
  'packages/boot/hmr/src/index.ts',
  'packages/boot/config-editor/src/index.ts',
  'packages/boot/plugin-manager/src/index.ts',
  'packages/boot/plugin-manager/src/operations.ts',
  'packages/boot/plugin-manager/src/official-install-target.ts',
  'packages/boot/plugin-market/src/index.ts',
  // Client module declarations and build.
  'packages/client/modules/src/client/manifest.ts',
  'packages/client/tsdown.client.ts',
  // Type-graph generation and the plugin market index.
  'packages/typert/generator/src/analyzer.ts',
  'apps/plugin-market-generator/src/packages.ts',
  // Test and packaging support.
  'packages/test-support/client-runtime/src/assembly/bundle-roster.ts',
  'packages/experimental/webworker-packer/src/repository.ts',
  'apps/desktop/scripts/smoke-runtime.ts',
  // Repository gates and catalogs.
  'scripts/browser-bundled-externals.ts',
  'scripts/check-workspace-constraints.ts',
  'scripts/dev-web.ts',
  'scripts/gen-official-bundle-catalog.ts',
  'scripts/gen-session-format-catalog.ts',
  'scripts/local-bundle-registry.ts',
  'scripts/optional-bundles.spec.ts',
  'scripts/doc-standard.spec.ts',
  'scripts/verify-client-packages.ts',
  'scripts/verify-cordis-config.ts',
  'scripts/verify-default-product-isolation.ts',
  'scripts/verify-package-dependencies.ts',
  'scripts/verify-product-use.ts',
]

/**
 * Skill directory names kept as-is. The declaration is explicit so drift from
 * `.agents/skills/` fails loudly instead of silently renaming a skill.
 */
const PRESERVED_SKILLS: readonly string[] = [
  'dsh-archive-agent-notes',
  'dsh-ci-test-reliability',
  'dsh-client-ui-ux',
  'dsh-code-review',
  'dsh-create-upgrade-guide',
  'dsh-doc',
  'dsh-error-handling',
  'dsh-find-simplifications',
  'dsh-merging-stacked-prs',
  'dsh-official-plugin-artwork',
  'dsh-pre-push-checks',
  'dsh-prose-standard',
  'dsh-responsive-ui',
  'dsh-speed-up-perf',
  'dsh-translate-docs',
  'dsh-trim-cot-leakage',
]

/** Fixed literals the pass must leave untouched wherever they appear. */
const PRESERVED_LITERALS: readonly string[] = ['dsh-libreoffice-kit']

/**
 * Spans exempt from every rule. `deepseek-harness` carries the upstream
 * repository name and the Python distributions; `@local/dsh-*` are local
 * profile template names, and `dsh-v<semver>` names a published release tag that
 * `docs/persistence-changes/` records as history rather than as a package.
 */
const PRESERVED_PATTERNS: readonly RegExp[] = [
  /deepseek[-_]harness/g,
  /@local\/dsh-[a-z0-9-]+/g,
  /dsh-v\d+\.\d+\.\d+[A-Za-z0-9.-]*/g,
]

/**
 * Tracked path names that a later stage must `git mv`. They are excluded from
 * the derived preserve set so their text rename still happens; the on-disk
 * names do not match until the move lands. `dsh` itself is the desktop launcher
 * file `apps/desktop/cli/dsh`, which must not shield the token everywhere.
 */
const MOVING_SEGMENTS: readonly string[] = ['dsh', '.dsh', '.dsh-project', '--dsh-workspace--']

/** Extensions the pass reads; binaries and asset formats stay untouched. */
const EXTENSIONS: readonly string[] = [
  '.bat', '.cjs', '.cmd', '.css', '.cts', '.example', '.html', '.js', '.json',
  '.jsonl', '.md', '.mjs', '.mts', '.nsh', '.patch', '.ps1', '.py', '.sh',
  '.snap', '.svg', '.swift', '.toml', '.tpl', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
]

/**
 * Extensionless tracked files that are text. They are named individually because
 * the extension allowlist cannot tell them from binaries: the desktop launcher
 * shells, and the Docker/sshd fixture that provisions a `dsh` login.
 */
const EXTENSIONLESS_FILES: readonly string[] = [
  'apps/desktop/cli/dsh',
  'Makefile',
  'packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/Dockerfile',
  'packages/ssh/ssh-helper-runtime/tests/fixtures/sshd/sshd_config',
]

/** Counts the stage-3 questions answer directly, reported beside the rule table. */
const PROBES: readonly { readonly id: string; readonly pattern: RegExp; readonly summary: string }[] = [
  { id: 'probe-cli-package', pattern: /@deepseek-ai\/dsh(?![-\w])/g, summary: '@deepseek-ai/dsh (apps/cli)' },
  { id: 'probe-boot-contract', pattern: /__DSH_BOOT__/g, summary: '__DSH_BOOT__ injection contract' },
  { id: 'probe-manifest-key', pattern: /^ *"dsh":/gm, summary: '"dsh": metadata key' },
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Tracked paths, in git order, which is stable across runs on one tree. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '')
}

/**
 * Collect every tracked path segment that carries a `dsh` token. Those names
 * exist on disk and the pass does not move them, so any text mentioning one —
 * a Markdown link, a `tsx scripts/prepare-dsh.ts` command, a skill directory —
 * must keep its exact spelling or the reference breaks.
 *
 * {@link MOVING_SEGMENTS} are dropped: they are fixture names the next stage
 * renames, and preserving them would suppress the `.dsh` home-directory rule.
 * @param files - Tracked repository-relative paths.
 * @returns Distinct segments containing a `dsh` token, longest first.
 */
function derivedPreservedSegments(files: readonly string[]): string[] {
  const moving = new Set(MOVING_SEGMENTS)
  const segments = new Set<string>()
  for (const file of files) {
    for (const segment of file.split('/')) {
      if (moving.has(segment)) continue
      if (/(?<![A-Za-z0-9])dsh/.test(segment)) segments.add(segment)
    }
  }
  return [...segments].sort((left, right) => right.length - left.length)
}

/**
 * Build the preserved-span alternation used to shield those names.
 * @param files - Tracked repository-relative paths.
 * @returns A global regular expression matching every preserved span.
 */
function preservePattern(files: readonly string[]): RegExp {
  const literals = [...derivedPreservedSegments(files), ...PRESERVED_LITERALS]
    .map(escapeRegExp)
  const sources = [...literals, ...PRESERVED_PATTERNS.map(pattern => pattern.source)]
    .sort((left, right) => right.length - left.length)
  return new RegExp(sources.join('|'), 'g')
}

/**
 * Why a tracked name keeps its `dsh` spelling. The order is the precedence used
 * when one segment occurs under several trees.
 */
const PRESERVED_CATEGORIES = ['historical', 'archived', 'skills', 'fixtures', 'source-or-script'] as const

/** One preserved name's reason for staying as-is. */
type PreservedCategory = typeof PRESERVED_CATEGORIES[number]

/**
 * Assign a tracked path to the reason its `dsh` name survives.
 * @param file - Repository-relative path with forward-slash separators.
 * @returns The path's preserved-name category.
 */
function categorizePath(file: string): PreservedCategory {
  if (file.startsWith('docs/persistence-changes/')) return 'historical'
  if (file.startsWith('.agents/notes/archived/')) return 'archived'
  if (file.startsWith('.agents/skills/')) return 'skills'
  if (file.startsWith('snapshots/') || file.includes('/fixtures/') || file.includes('/tests/')) return 'fixtures'
  return 'source-or-script'
}

/**
 * Classify every preserved segment by the trees it appears in.
 * @param files - Tracked repository-relative paths.
 * @param segments - The preserved segments to classify.
 * @returns Each segment's highest-precedence category.
 */
function preservedSegmentCategories(files: readonly string[], segments: readonly string[]): Map<string, PreservedCategory> {
  const wanted = new Set(segments)
  const rank = new Map<string, number>(PRESERVED_CATEGORIES.map((category, index) => [category, index]))
  const categories = new Map<string, PreservedCategory>()
  for (const file of files) {
    const parts = file.split('/')
    for (const [index, segment] of parts.entries()) {
      if (!wanted.has(segment)) continue
      // Classify by where the name sits, not by the whole path: `subagent-dsh-sdk`
      // is a source directory even though its own tests mention the same name.
      const category = categorizePath(parts.slice(0, index + 1).join('/'))
      const current = categories.get(segment)
      if (current !== undefined && (rank.get(current) ?? 0) <= (rank.get(category) ?? 0)) continue
      categories.set(segment, category)
    }
  }
  return categories
}

/**
 * Report the package names the pass leaves carrying a `dsh` segment, because a
 * preserved directory name sits inside the package name itself.
 * @param file - Repository-relative path of a scanned `package.json`.
 * @param rewritten - Its post-rename text.
 * @returns The package name, when it still carries `dsh`.
 */
function residualPackageName(file: string, rewritten: string): string | undefined {
  if (!file.endsWith('package.json')) return undefined
  const name = /"name":\s*"([^"]+)"/.exec(rewritten)?.[1]
  return name !== undefined && name.includes('dsh') ? name : undefined
}

/**
 * Identify files the pass must skip entirely.
 * @param file - Repository-relative path with forward-slash separators.
 * @returns Whether the file stays outside the rename.
 */
export function isRescopeExcluded(file: string): boolean {
  if (file === SCRIPT_FILE) return true // the mapping itself
  if (file.startsWith('vendor/')) return true // vendored upstream sources
  if (file.startsWith('.agents/notes/archived/')) return true // frozen records
  if (file === 'THIRD_PARTY_NOTICES.md') return true // `pnpm run gen-third-party-notices`
  if (/(^|\/)LICEN[CS]E(\.[A-Za-z0-9.]+)?$/.test(file)) return true // licence text
  if (file.startsWith('scripts/snapshots/')) return true // recorded payloads quote docs; `pnpm run test:snapshot:record`
  if (file.endsWith('.i18n.yaml')) return true // blob hashes; the pairing gate re-records them
  if (file === 'pnpm-lock.yaml') return true // `pnpm install`
  if (file === 'scripts/dependency-catalog/package-lock.json') return true // `gen-dependency-catalog --refresh`
  if (EXTENSIONLESS_FILES.includes(file)) return false
  return !EXTENSIONS.includes(extname(file))
}

/** Occurrences one rule consumed, counted per file while scanning. */
type Tally = Map<string, number>

/**
 * Rewrite one unprotected line.
 * @param line - Line text with no preserved span.
 * @param rules - Rules in application order.
 * @param forward - Whether to apply the forward or the reverse form.
 * @param tally - Per-rule occurrence counters to increment.
 * @returns The rewritten line.
 */
function rewriteSpan(line: string, rules: readonly Rule[], forward: boolean, tally: Tally): string {
  let out = line
  for (const rule of rules) {
    const [pattern, replacement] = forward ? rule.forward : rule.reverse
    const matched = out.match(pattern)
    if (matched === null) continue
    tally.set(rule.id, (tally.get(rule.id) ?? 0) + matched.length)
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Rewrite a line, leaving every preserved span byte-identical.
 * @param line - One file line.
 * @param rules - Rules in application order.
 * @param forward - Whether to apply the forward or the reverse form.
 * @param tally - Per-rule occurrence counters to increment.
 * @param preserve - The preserved-span alternation.
 * @returns The rewritten line.
 */
function rewriteLine(line: string, rules: readonly Rule[], forward: boolean, tally: Tally, preserve: RegExp): string {
  let out = ''
  let cursor = 0
  for (const match of line.matchAll(preserve)) {
    const index = match.index
    out += rewriteSpan(line.slice(cursor, index), rules, forward, tally)
    out += match[0]
    cursor = index + match[0].length
  }
  return out + rewriteSpan(line.slice(cursor), rules, forward, tally)
}

/** Directory key used for the coarse per-tree report: the top two path segments. */
function directoryOf(file: string): string {
  const segments = file.split('/')
  return segments.length > 2 ? `${segments[0]}/${segments[1]}` : segments[0] ?? file
}

/**
 * Read a text file, or report that it is binary.
 * @param path - Absolute file path.
 * @returns The UTF-8 text, or `undefined` when the head holds a NUL byte.
 */
function readText(path: string): string | undefined {
  const buffer = readFileSync(path)
  if (buffer.subarray(0, 8192).includes(0)) return undefined
  return buffer.toString('utf8')
}

/** The skill directories actually present, for the drift assertion. */
function actualSkillDirectories(): string[] {
  const directory = resolve(root, '.agents/skills')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-'))
    .map(entry => entry.name)
    .sort()
}

function main(): void {
  const args = process.argv.slice(2)
  const mode = args.includes('--apply') ? 'apply' : args.includes('--check') ? 'check' : args.includes('--list') ? 'list' : 'dry'
  const forward = !args.includes('--reverse')
  const rules = forward ? RULES : [...RULES].reverse()

  const failures: string[] = []
  const declared = [...PRESERVED_SKILLS].sort()
  const present = actualSkillDirectories()
  if (declared.join('\n') !== present.join('\n')) {
    failures.push(`PRESERVED_SKILLS drifted from .agents/skills: declared ${String(declared.length)}, on disk ${String(present.length)}`)
  }

  const tracked = trackedFiles()
  const preservedSegments = derivedPreservedSegments(tracked)
  const preserve = preservePattern(tracked)
  const files = tracked.filter(file => !isRescopeExcluded(file))
  const moving = tracked.filter(file => MOVING_SEGMENTS.some(segment => file.split('/').includes(segment)))

  const tally = new Map<string, { hits: number; files: number }>()
  const probe = new Map<string, { hits: number; files: number }>()
  const changed: string[] = []
  const residual: string[] = []
  const perDirectory = new Map<string, { hits: number; files: number }>()
  let totalHits = 0

  for (const file of files) {
    const path = resolve(root, file)
    const before = readText(path)
    if (before === undefined) continue
    const fileTally: Tally = new Map()
    const after = before.split('\n').map(line => rewriteLine(line, rules, forward, fileTally, preserve)).join('\n')
    if (after === before) continue
    // Re-running the rules over their own output must change nothing; anything
    // else means an applied `--apply` would leave a second pass with work to do.
    const settled = after.split('\n').map(line => rewriteLine(line, rules, forward, new Map(), preserve)).join('\n')
    if (settled !== after) failures.push(`not idempotent: ${file} still matches a rule after the rewrite`)
    const name = residualPackageName(file, after)
    if (name !== undefined) residual.push(`${name}  (${file})`)
    changed.push(file)
    let fileHits = 0
    for (const [id, hits] of fileTally) {
      fileHits += hits
      const current = tally.get(id) ?? { hits: 0, files: 0 }
      tally.set(id, { hits: current.hits + hits, files: current.files + 1 })
    }
    for (const { id, pattern } of PROBES) {
      const matched = before.match(pattern)
      if (matched === null) continue
      const current = probe.get(id) ?? { hits: 0, files: 0 }
      probe.set(id, { hits: current.hits + matched.length, files: current.files + 1 })
    }
    totalHits += fileHits
    const key = directoryOf(file)
    const bucket = perDirectory.get(key) ?? { hits: 0, files: 0 }
    perDirectory.set(key, { hits: bucket.hits + fileHits, files: bucket.files + 1 })
    if (mode === 'apply') writeFileSync(path, after)
  }

  const label = forward ? 'forward' : 'reverse'
  console.log(`rescope-mwf: ${mode} (${label}) over ${String(files.length)} scannable tracked files`)
  for (const rule of rules) {
    const measured = tally.get(rule.id) ?? { hits: 0, files: 0 }
    if (measured.hits === 0) continue
    const flag = forward && measured.hits !== rule.expect ? ` (!= expected ${String(rule.expect)})` : ''
    console.log(`  [s${String(rule.stage)}] ${rule.id.padEnd(21)} ${String(measured.hits).padStart(6)} hit(s) in ${String(measured.files).padStart(4)} file(s)  ${rule.summary}${flag}`)
  }
  console.log(`rescope-mwf: ${String(changed.length)} file(s), ${String(totalHits)} hit(s)${mode === 'apply' ? ' written' : ' would change'}`)

  console.log('rescope-mwf: stage-3 probes')
  for (const { id, summary } of PROBES) {
    const measured = probe.get(id) ?? { hits: 0, files: 0 }
    console.log(`  ${summary.padEnd(32)} ${String(measured.hits).padStart(6)} hit(s) in ${String(measured.files).padStart(4)} file(s)`)
  }

  const top = [...perDirectory.entries()].sort((left, right) => right[1].hits - left[1].hits).slice(0, 10)
  console.log('rescope-mwf: top directories by hit count')
  for (const [directory, value] of top) {
    console.log(`  ${directory.padEnd(26)} ${String(value.files).padStart(5)} file(s), ${String(value.hits).padStart(6)} hit(s)`)
  }

  if (mode === 'list') {
    for (const file of changed) console.log(`  ${file}`)
    console.log(`rescope-mwf: ${String(MANIFEST_READERS.length)} manifest read site(s) renamed to \`mwf\` (no dual read):`)
    for (const reader of MANIFEST_READERS) console.log(`  ${reader}`)
    console.log(`rescope-mwf: ${String(moving.length)} tracked path(s) folded into the apply stage as \`git mv\`:`)
    for (const file of moving) console.log(`  ${file}`)
    console.log(`rescope-mwf: ${String(residual.length)} package name(s) keep a \`dsh\` segment through a preserved name (cleanup candidates):`)
    for (const entry of residual) console.log(`  ${entry}`)
    const categories = preservedSegmentCategories(tracked, preservedSegments)
    console.log(`rescope-mwf: ${String(preservedSegments.length)} preserved path segment(s), by category:`)
    const rows = [...preservedSegments]
      .map(segment => ({ segment, category: categories.get(segment) ?? 'source-or-script' }))
      .sort((left, right) => left.category.localeCompare(right.category) || left.segment.localeCompare(right.segment))
    for (const { segment, category } of rows) console.log(`  ${category.padEnd(16)} ${segment}`)
    for (const pattern of PRESERVED_PATTERNS) {
      const category = pattern.source.includes('dsh-v') ? 'historical' : 'source-or-script'
      console.log(`  ${category.padEnd(16)} ${pattern.source}  (pattern)`)
    }
    console.log(`rescope-mwf: ${String(DEFERRED_RULES.length)} deferred mapping(s):`)
    for (const rule of DEFERRED_RULES) console.log(`  ${rule}`)
  }

  const preview = !args.includes('--apply') && args.includes('--preview') ? args[args.indexOf('--preview') + 1] : undefined
  if (preview !== undefined) {
    const lines = (readText(resolve(root, preview)) ?? '').split('\n')
    const after = lines.map(line => rewriteLine(line, rules, forward, new Map(), preserve))
    for (const [index, line] of lines.entries()) {
      const next = after[index] ?? line
      if (line === next) continue
      console.log(`  ${preview}:${String(index + 1)}`)
      console.log(`  - ${line}`)
      console.log(`  + ${next}`)
    }
  }

  if (mode !== 'apply') {
    for (const rule of RULES) {
      if (!forward) continue
      const measured = tally.get(rule.id)?.hits ?? 0
      // Pre-rename or fully landed are the only two valid states for a rule.
      if (measured === 0 || measured === rule.expect) continue
      failures.push(`rule ${rule.id}: ${String(measured)} hit(s), expected ${String(rule.expect)} or 0 (site moved since the mapping was recorded)`)
    }
  }
  for (const failure of failures) console.error(`rescope-mwf: ${failure}`)

  if (mode !== 'apply' && (totalHits > 0 || failures.length > 0)) {
    console.error(`rescope-mwf: ${String(totalHits)} unreplaced hit(s) remain; nothing was written.`)
    process.exitCode = 1
  } else if (mode === 'apply') {
    console.log('rescope-mwf: applied. Next: `pnpm install`, then the stage-2 generators, then the stage-3 `git mv` list and re-recording.')
  } else {
    console.log('rescope-mwf: clean — no pre-rename token remains.')
  }
}

// Importing this module for its exported predicate must not run the rename.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}

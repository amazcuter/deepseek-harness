/** Explicit exceptions and Host packages for the published dependency policy. */

/** Packages treated as Client/Host packages without declaring `mwf.client`. */
const CLIENT_FACE_INCLUDE: readonly string[] = []

/** Packages exempted from automatic Client/Host treatment despite declaring `mwf.client`. */
const CLIENT_FACE_EXCLUDE: readonly string[] = [
  '@metaworkflow/api-session-controller',
  '@metaworkflow/api-workspace-controller',
]

/** Host-only packages whose peer relays are deliberately flattened. */
const HOST_DEPENDENCY_PACKAGES: readonly string[] = [
  '@metaworkflow/llm',
  '@metaworkflow/session',
]

/** Required Cordis services whose Host imports are type-only. */
const REQUIRED_SERVICE_PEERS = {
  '@metaworkflow/api-terminal-controller': ['@metaworkflow/subprocess'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Development-only package relationships not represented by source imports. */
const CONFIGURATION_ONLY_DEV_DEPENDENCIES = {
  '@metaworkflow/client-locale': ['@metaworkflow/api-remotes'],
  '@metaworkflow/client-ui-conversation': [
    '@metaworkflow/api-remotes',
    '@metaworkflow/client-ui-workspace',
  ],
  '@metaworkflow/client-ui-model-selection': ['@metaworkflow/client-ui-input-trigger'],
  '@metaworkflow/client-ui-sidebar': ['@metaworkflow/client-ui-workspace'],
  '@metaworkflow/client-ui-subagent': ['@metaworkflow/client-ui-input-trigger'],
  '@metaworkflow/client-ui-theme': ['@metaworkflow/api-remotes'],
  '@metaworkflow/client-ui-tool': ['@metaworkflow/api-remotes'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Workspace packages whose complete runtime surface is safe across duplicate installations. */
const DUPLICATE_SAFE_PACKAGES: readonly string[] = [
  '@metaworkflow/brand',
  '@metaworkflow/lazy-require',
  '@metaworkflow/typert-protocol',
  '@metaworkflow/util-code-language',
  '@metaworkflow/util-crypto',
  '@metaworkflow/util-values',
]

/**
 * Runtime exports whose values remain valid when npm installs another package copy.
 * New entries are forbidden by default. Automated agents must not add an
 * exception; every addition requires explicit human review and a dedicated,
 * prominent heading in the pull request description.
 */
const SAFE_HOST_DEPENDENCY_EXPORTS = {
  '@metaworkflow/credentials': ['credentialKey'],
  '@metaworkflow/deque': ['Deque'],
  '@metaworkflow/llm': ['callConfigEquals'],
  '@metaworkflow/session-format': ['sessionFormatLogFilename'],
  '@metaworkflow/timeout': ['MAX_TIMER_DELAY_MS'],
  '@deepseek-ai/schemastery': ['default'],
} as const satisfies HostDependencyExports

/** Runtime exports that require every consumer to resolve the provider's shared peer instance. */
const PEER_REQUIRED_HOST_EXPORTS = {
  // `instanceof` checks need the translator's own class instance.
  '@metaworkflow/experimental-translator': ['TranslationError'],
  '@metaworkflow/scope': ['carrierKeyOf', 'createScope', 'scopeOf', 'scopeTarget'],
  '@metaworkflow/session': ['SESSION_FORMAT_VERSION'],
  '@metaworkflow/session-persistence': ['SessionPersistenceNotFoundError'],
} as const satisfies HostDependencyExports

/** Exact import specifier to reviewed runtime exports. */
type HostDependencyExports = Readonly<Record<string, readonly string[]>>

/** Complete configurable input to package dependency classification. */
export interface PackageDependencyPolicy {
  readonly clientFaceInclude: readonly string[]
  readonly clientFaceExclude: readonly string[]
  readonly hostPackages: readonly string[]
  readonly requiredServicePeers?: Readonly<Record<string, readonly string[]>>
  readonly configurationOnlyDevDependencies: Readonly<Record<string, readonly string[]>>
  readonly duplicateSafePackages?: readonly string[]
  readonly safeHostDependencyExports: HostDependencyExports
  readonly peerRequiredHostExports: HostDependencyExports
}

/** Repository dependency policy consumed by verification and benchmarking. */
export const PACKAGE_DEPENDENCY_POLICY: PackageDependencyPolicy = {
  clientFaceInclude: CLIENT_FACE_INCLUDE,
  clientFaceExclude: CLIENT_FACE_EXCLUDE,
  hostPackages: HOST_DEPENDENCY_PACKAGES,
  requiredServicePeers: REQUIRED_SERVICE_PEERS,
  configurationOnlyDevDependencies: CONFIGURATION_ONLY_DEV_DEPENDENCIES,
  duplicateSafePackages: DUPLICATE_SAFE_PACKAGES,
  safeHostDependencyExports: SAFE_HOST_DEPENDENCY_EXPORTS,
  peerRequiredHostExports: PEER_REQUIRED_HOST_EXPORTS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a package manifest declares a dynamically loaded Client entry. */
export function hasClientDeclaration(mwfField: unknown): boolean {
  return isRecord(mwfField) && Object.hasOwn(mwfField, 'client')
}

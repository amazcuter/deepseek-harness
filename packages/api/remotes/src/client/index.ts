/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@deepseek-ai/cordis'
import productAnalyticsRemote from '@metaworkflow/client-product-analytics/remote'
export type {} from '@metaworkflow/client-product-analytics/remote'
import agentPresetsRemote from '@metaworkflow/agent-preset-registry/remote'
import userQuestionsRemote from '@metaworkflow/user-questions/remote'
import commandsRemote from '@metaworkflow/commands/remote'
import accountRemote from '@metaworkflow/api-account-controller/remote'
import settingsControllerRemote from '@metaworkflow/api-settings-controller/remote'
import officeToPdfRemote from '@metaworkflow/office-to-pdf/remote'
import goalsRemote from '@metaworkflow/goal/remote'
import scheduleRemote from '@metaworkflow/schedule/remote'
import llmRemote from '@metaworkflow/llm/remote'
import dynamicRemote from '@metaworkflow/cordis-host-runner/remote'
import pluginManagerRemote from '@metaworkflow/plugin-manager/remote'
import pluginRegistryProbeRemote from '@metaworkflow/client-ui-plugin-manager/remote'
import pluginMarketRemote from '@metaworkflow/plugin-market/remote'
import pluginInventoryRemote from '@metaworkflow/host-plugin-inventory/remote'
import messageFeedbackRemote from '@metaworkflow/message-feedback/remote'
import permissionPresetsRemote from '@metaworkflow/permission-presets/remote'
import sessionFeedbackRemote from '@metaworkflow/command-feedback/remote'
import fileUploadsRemote from '@metaworkflow/client-file-upload/remote'
import sessionReferencesRemote from '@metaworkflow/session-reference/remote'
import subagentsRemote from '@metaworkflow/subagent/remote'
import sessionRemote from '@metaworkflow/api-session-controller/remote'
import jobRemote from '@metaworkflow/api-job-controller/remote'
import workspaceRemote from '@metaworkflow/api-workspace-controller/remote'
import terminalRemote from '@metaworkflow/api-terminal-controller/remote'
import workspaceFilesRemote from '@metaworkflow/api-workspace-files/remote'
import type { ClientRemote } from '@metaworkflow/api-gateway/client'

export type { ClientRemote } from '@metaworkflow/api-gateway/client'
export type {
  BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind, ManagementError,
  PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  ReadOnlyReason, Registry, RestartReason,
} from '@metaworkflow/plugin-manager/types'
export type {} from '@metaworkflow/plugin-manager/remote'
export type {} from '@metaworkflow/client-ui-plugin-manager/remote'
export type {} from '@metaworkflow/plugin-market/remote'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort,
} from '@metaworkflow/plugin-market/types'
export type { PluginInventorySnapshot } from '@metaworkflow/host-plugin-inventory/types'
export type {} from '@metaworkflow/agent-preset-registry/remote'
export type {} from '@metaworkflow/user-questions/remote'
export type {} from '@metaworkflow/commands/remote'
export type {} from '@metaworkflow/api-settings-controller/remote'
export type {} from '@metaworkflow/api-account-controller/remote'
export type {} from '@metaworkflow/goal/remote'
export type {} from '@metaworkflow/schedule/remote'
export type {} from '@metaworkflow/office-to-pdf/remote'
export type {} from '@metaworkflow/llm/remote'
export type {} from '@metaworkflow/host-plugin-inventory/remote'
export type {} from '@metaworkflow/message-feedback/remote'
export type {} from '@metaworkflow/permission-presets/remote'
export type {} from '@metaworkflow/command-feedback/remote'
export type {} from '@metaworkflow/client-file-upload/remote'
export type {} from '@metaworkflow/session-reference/remote'
export type {} from '@metaworkflow/subagent/remote'
export type * from '@metaworkflow/subagent/client'
export type {} from '@metaworkflow/api-session-controller/remote'
export type * from '@metaworkflow/api-session-controller/types'
export type {} from '@metaworkflow/api-job-controller/remote'
export type * from '@metaworkflow/api-job-controller/types'
export type {} from '@metaworkflow/api-workspace-controller/remote'
export type * from '@metaworkflow/api-workspace-controller/types'
export type {} from '@metaworkflow/api-workspace-files/remote'
export type * from '@metaworkflow/api-workspace-files/types'
export type {} from '@metaworkflow/api-terminal-controller/remote'
export type * from '@metaworkflow/api-terminal-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@metaworkflow/commands/types'
export type {} from '@metaworkflow/cordis-host-runner/types'
export type {} from '@metaworkflow/credentials/types'
export type {} from '@metaworkflow/llm/types'
export type {} from '@metaworkflow/agent-preset-registry/types'
export type {} from '@metaworkflow/permission-presets/types'
export type {} from '@metaworkflow/settings/types'
export type {} from '@metaworkflow/user-approval/types'
export type {} from '@metaworkflow/user-questions/types'
export type {} from '@metaworkflow/api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@metaworkflow/client-connection/client'
export type {} from '@metaworkflow/api-gateway/client'
export type {} from '@metaworkflow/cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@metaworkflow/cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@metaworkflow/credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@metaworkflow/settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@metaworkflow/llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@metaworkflow/file-reference/types'
export type { SessionReferenceMentionCandidate } from '@metaworkflow/session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// mwf-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@metaworkflow/typert-protocol'
export type { RemoteHostFacts } from '@metaworkflow/api-gateway/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}

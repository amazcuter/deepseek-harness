/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@metaworkflow/client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@metaworkflow/client-ui-sidebar-browser/types'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  shortcutsInput: 'mwf-desktop:shortcuts-input',
  shortcutsCloseWindow: 'mwf-desktop:shortcuts-close-window',
  shortcutsGet: 'mwf-desktop:shortcuts-get',
  shortcutsEdit: 'mwf-desktop:shortcuts-edit',
  shortcutsChanged: 'mwf-desktop:shortcuts-changed',
  shortcutsRecording: 'mwf-desktop:shortcuts-recording',
  boot: 'mwf-desktop:boot',
  enterWorkspace: 'mwf-desktop:enter-workspace',
  onboardingActive: 'mwf-desktop:onboarding-active',
  onboardingApiKey: 'mwf-desktop:onboarding-api-key',
  bootFailed: 'mwf-desktop:boot-failed',
  browserAcquire: 'mwf-desktop:browser-acquire',
  browserRelease: 'mwf-desktop:browser-release',
  browserOpenRequested: 'mwf-desktop:browser-open-requested',
  directoryPick: 'mwf-desktop:directory-pick',
  deviceInfo: 'mwf-desktop:device-info',
  localeBootstrap: 'mwf-desktop:locale-bootstrap',
  localeChanged: 'mwf-desktop:locale-changed',
  updatesStatus: 'mwf-desktop:updates-status',
  updatesOpen: 'mwf-desktop:updates-open',
  updatesPresentation: 'mwf-desktop:updates-presentation',
  nativeThemeSet: 'mwf-desktop:native-theme-set',
  windowFullscreen: 'mwf-desktop:window-fullscreen',
  windowsAppearance: 'mwf-desktop:windows-appearance',
  windowsMenu: 'mwf-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface MwfDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'mwf-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('mwf desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('mwf desktop: rejected IPC from an unowned renderer')
  }
}

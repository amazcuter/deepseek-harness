/** Shared names for the desktop Platform bridge. */
/** Private desktop channels; the Platform renderer receives bootstrap and locale updates. */
export const PLATFORM_IPC = {
  bootstrap: 'mwf-platform:bootstrap',
  localeChanged: 'mwf-platform:locale-changed',
  open: 'mwf-platform:open',
  bounds: 'mwf-platform:bounds',
  close: 'mwf-platform:close',
} as const

/** Resolved Platform language; Desktop resolves the system preference before sending it. */
export type PlatformLocale = 'en_US' | 'zh_CN'

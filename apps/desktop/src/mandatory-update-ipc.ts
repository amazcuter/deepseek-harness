/** Dependency-free IPC names shared with the sandboxed mandatory-update preload. */
export const MANDATORY_IPC = {
  status: 'mwf-desktop:mandatory-status', state: 'mwf-desktop:mandatory-state', action: 'mwf-desktop:mandatory-action',
} as const

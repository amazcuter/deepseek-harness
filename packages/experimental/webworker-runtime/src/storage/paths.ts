/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const MWF_ROOT = '/mwf'

/** `$MWF_HOME`: durable-state directory inside the image. */
export const MWF_HOME = `${MWF_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const MWF_NODE_MODULES = `${MWF_ROOT}/node_modules`

/** Image configuration directory: the VFS manifest and the shipped agent presets. */
export const MWF_CONFIG = `${MWF_ROOT}/config`

/** Default (empty) workspace directory. */
export const MWF_WORKSPACE = `${MWF_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const MWF_TMP = `${MWF_ROOT}/tmp`

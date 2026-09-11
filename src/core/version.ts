/**
 * Which release this is, wherever it is running.
 *
 * The version is stamped in at build time as `__APP_VERSION__` rather than read
 * from `package.json`, because by the time any of this is running there may not
 * *be* a `package.json` next to it: the daemon tarball is a Node binary and two
 * bundles, and the packaged app keeps its manifest inside an asar.
 *
 * `src/cli/router.ts` has done this since M3.3 for `gitwarren --version`. M4
 * needs the same string one level down - `app.instance` reports it to whoever
 * connected - and a second guarded `typeof` in a second file is how a constant
 * quietly acquires two values.
 *
 * The guard is not decoration. Each bundle defines the constant separately, and
 * an undefined identifier in a bundle that forgot to is a `ReferenceError` at
 * module scope, which takes the whole process down rather than reporting an odd
 * version. Falling back is the right failure: nothing branches on this string.
 */
declare const __APP_VERSION__: string

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

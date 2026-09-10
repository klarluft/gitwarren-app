/**
 * Keep `ws` on its pure-JavaScript path, in every bundle that contains it.
 *
 * `ws` ships optional native accelerators - `bufferutil` for masking, and
 * `utf-8-validate` - and reaches for them at the bottom of two of its modules
 * like this:
 *
 * ```js
 * if (!process.env.WS_NO_BUFFER_UTIL) {
 *   try {
 *     const bufferUtil = require('bufferutil')
 *     module.exports.unmask = (buffer, mask) => { … }   // reassignment
 *   } catch (e) {}
 * }
 * ```
 *
 * Neither package is installed here, so at runtime that `require` throws, the
 * `catch` swallows it, and the pure-JS implementation stands. Inside a bundle it
 * is not so simple: the reassignment of `module.exports.unmask` is a CommonJS
 * pattern with no ESM equivalent, and Rollup's ESM output turns the module's
 * own later reference to it into `bufferUtil$1.unmask`, which is `undefined`.
 * The first client frame then dies with
 *
 *     TypeError: bufferUtil$1.unmask is not a function
 *
 * inside `Receiver._write`, before anything of ours runs. Every frame a browser
 * sends is masked, so the effect is a socket that connects perfectly, accepts
 * everything, and answers nothing - an upgrade that looks entirely healthy from
 * both ends and a UI that simply never loads.
 *
 * This bit the Electron main bundle and not the daemon, because the main
 * process is built as ESM and `out/daemon/serve.cjs` is CommonJS. That is a
 * distinction no one should have to remember, so both builds set this rather
 * than the one that happened to break.
 *
 * Defining the variables here makes each `if` a constant false at build time,
 * so the optional block is removed entirely and there is no reassignment left
 * to mistranslate. It costs nothing: the accelerators were never installed, and
 * masking a loopback frame in JavaScript is not a cost worth measuring.
 */
export const WS_PURE_JS = {
  'process.env.WS_NO_BUFFER_UTIL': '"1"',
  'process.env.WS_NO_UTF_8_VALIDATE': '"1"'
} as const

/**
 * electron-builder `afterPack` hook: ad-hoc sign macOS builds that have no
 * real certificate.
 *
 * Electron's prebuilt binary arrives linker-signed ad-hoc, which is what lets
 * it run on Apple Silicon at all — the kernel refuses to execute an arm64
 * binary with no signature whatsoever. electron-builder then renames the
 * bundle and adds resources to it, which invalidates that signature's seal,
 * and when no signing identity is configured it skips re-signing entirely.
 *
 * The result passes locally, because a bundle you built yourself carries no
 * `com.apple.quarantine` attribute and Gatekeeper is never consulted. Download
 * the same file from a GitHub release and Gatekeeper does look, finds a
 * signature whose seal does not match the bundle, and reports the app as
 * *damaged* — which reads to a user as malware rather than as the ordinary
 * "unidentified developer" they know how to click past.
 *
 * Re-signing ad-hoc costs nothing and fixes only that: the signature becomes
 * self-consistent, so an unsigned download is refused for the honest reason
 * (not notarized) and the Privacy & Security override works. It is not a
 * substitute for a Developer ID — the app still cannot notarize and still
 * cannot auto-update.
 *
 * Skipped when CSC_LINK is set, since electron-builder is then about to sign
 * properly and would overwrite this anyway.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (process.env.CSC_LINK) {
    console.log('  • ad-hoc signing skipped   reason=CSC_LINK is set, real signing will run')
    return
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // --deep is deprecated for distribution signing, where each nested binary
  // should be signed on its own terms. For an ad-hoc signature that nothing
  // will ever validate against a certificate chain, it is the one command that
  // reliably covers the Electron helpers, the frameworks and the unpacked
  // better-sqlite3 .node addon in a single pass.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })

  console.log(`  • ad-hoc signed            ${appPath}`)
}

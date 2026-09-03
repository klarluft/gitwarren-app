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
 * Skipped whenever electron-builder is about to sign for real and would
 * overwrite this anyway: CSC_KEYCHAIN set (the CI path — the release workflow
 * imports the .p12 into a keychain of its own rather than letting
 * electron-builder do it, see the comment there), CSC_LINK set (the same on
 * Windows, and still honoured on macOS for anyone signing by hand), or a
 * Developer ID Application identity already in the keychain (the local path,
 * after `npm run package` on a machine enrolled in the Developer Program).
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * True when the keychain holds a Developer ID Application identity that
 * electron-builder will find on its own. Auto-discovery being off means it
 * will not go looking, so the keychain does not matter in that case.
 */
function hasDeveloperIdIdentity() {
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return false

  // CSC_KEYCHAIN names a keychain that may not be in the default search list,
  // so ask about it directly rather than trusting the list to include it.
  const keychain = process.env.CSC_KEYCHAIN
  const args = ['find-identity', '-v', '-p', 'codesigning']
  if (keychain) args.push(keychain)

  try {
    const identities = execFileSync('security', args, {
      encoding: 'utf8'
    })
    return identities.includes('Developer ID Application')
  } catch {
    // No keychain, or `security` unavailable — treat it as no identity and
    // fall through to the ad-hoc signature.
    return false
  }
}

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (process.env.CSC_KEYCHAIN) {
    console.log('  • ad-hoc signing skipped   reason=CSC_KEYCHAIN is set, real signing will run')
    return
  }

  if (process.env.CSC_LINK) {
    console.log('  • ad-hoc signing skipped   reason=CSC_LINK is set, real signing will run')
    return
  }

  if (hasDeveloperIdIdentity()) {
    console.log(
      '  • ad-hoc signing skipped   reason=Developer ID in keychain, real signing will run'
    )
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

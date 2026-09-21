# Releasing

Maintainer notes: cutting a release, how the updater finds it, and the signing
and notarization setup on each platform. Nobody needs this to use GitWarren or
to send a patch.

## Release process

Artifacts and the update manifest are published to **GitHub Releases**
(`klarluft/gitwarren-app`, configured in `electron-builder.yml`).

```bash
# 1. Bump the version. electron-builder reads it from package.json,
#    and it becomes the version electron-updater compares against.
npm version patch          # or minor / major — creates a commit and a tag
#    The `version` script copies the number into the plugin manifests and the
#    Dockerfile's pin at the repository root, so that one commit says the
#    version everywhere it appears.

# 2. Verify before shipping.
npm run lint && npm test

# 3. Build and publish.
export GH_TOKEN=<a token with `repo` scope>
npm run release            # electron-builder --publish always

# 4. Push the tag.
git push --follow-tags
```

`npm run release` runs the typecheck, builds all four bundles, packages the
installers, and uploads them plus the manifests to a GitHub release for the
current tag. The release is created as a **draft** — publish it in the GitHub UI
when you are ready, and that is the moment clients begin to see the update.

The same workflow publishes the npm package, and after it the server's entry in
the [MCP registry](https://registry.modelcontextprotocol.io) from `server.json`
at the repository root, for stable tags only. Both use the job's OIDC token; no
secret is involved.

Publishing a *stable* release also fans out to two other places, both on the
`release: published` event: `deploy-site.yml` rebuilds gitwarren.com so its
download buttons point at the new assets, and `homebrew-tap.yml` asks
[klarluft/homebrew-tap](https://github.com/klarluft/homebrew-tap) to move its
cask to the new version and checksums. The tap needs a `HOMEBREW_TAP_TOKEN`
secret for that nudge to be immediate; without one it still catches the
release on its own schedule within a few hours.

### Prereleases

A tag carrying a prerelease component — `v0.1.7-beta.3` — is a build for
testers, and the pipeline keeps it away from everyone else. The draft is
created `--prerelease`, and both fan-outs above decline to run for one: the
website goes on advertising the newest stable release, and the Homebrew cask
stays where it is.

That flag is load-bearing. GitHub's `/releases/latest` skips a prerelease, and
that endpoint is what electron-updater asks on behalf of every install running
a stable version — `allowPrerelease` is derived from the *installed* version,
so a 0.1.6 install never looks at a beta. Nothing else in the release says so:
the update manifests inside a beta are still named `latest.yml`, because
electron-builder derives no channel for the GitHub provider. Clear the flag,
or tick *Set as the latest release* while publishing, and every stable install
takes the beta on its next six-hourly check.

So publish one explicitly rather than through the UI's defaults:

```bash
gh release edit v0.1.7-beta.3 --draft=false --prerelease --latest=false
```

Testers keep updating among themselves from there — a beta install looks for
`beta-mac.yml`, gets a 404, and falls back to the `latest.yml` in the same
release — and each one moves to the next stable release on its own, with no
reinstall, as long as that version is higher than the beta they are on.

To build without publishing (for local testing):

```bash
npm run package        # installers into release/<version>/
npm run package:dir    # unpacked app only, much faster
```

### What gets produced

| Platform | Artifacts |
| --- | --- |
| Windows | `GitWarren-<v>-x64.exe`, `-arm64.exe` (NSIS), `.blockmap` each, `latest.yml` |
| macOS | `-arm64.dmg`, `-x64.dmg`, `-arm64.zip`, `-x64.zip`, `.blockmap` each, `latest-mac.yml` |
| Linux | `-x86_64.AppImage`, `-arm64.AppImage`, `latest-linux.yml`, `latest-linux-arm64.yml` |
| Any host | `gitwarren-daemon-<v>-{linux,darwin}-{x64,arm64}.tar.gz` |
| Homebrew | `gitwarren-cli.rb`, the formula with this release's four checksums |
| npm | `gitwarren@<v>`, published from `out/npm` by trusted publishing |

The `.blockmap` files are what make updates differential: electron-updater
compares block hashes with the installed version and downloads only the changed
ranges.

The macOS **zip is required** — electron-updater reads the zip, not the dmg.
Dropping that target still produces a working installer but silently breaks
auto-update.

The **daemon tarballs** are not installers and electron-updater ignores them.
Each carries a Node binary, the CLI and MCP bundles, the one matching
`better_sqlite3.node`, the migrations and the web build — about 40 MB, and
enough to run GitWarren on a box with nothing installed on it. They are built by
the `daemon` job in `release.yml` from `scripts/build-daemon-tarball.mjs`, on
one runner for all four targets, and nothing in them is compiled: better-sqlite3
ships a prebuild for each, and the Node binaries are downloaded.

There is no Windows tarball, on purpose. A `.tar.gz` is not how anything is
installed there, and both audiences are already served — a desktop user installs
the app, and someone who wants the command line has `npx gitwarren`.

Their **file names are a contract**. A GitWarren installing a daemon on a
remote host runs `uname -sm` there, maps the answer to one of the four targets,
and fetches `gitwarren-daemon-<version>-<target>.tar.gz` from the release by URL
— one request, no listing and no search. The Homebrew formula names the same
URLs. Renaming them breaks both.

The **npm package** carries no credential to publish it. The `daemon` job asks
GitHub for an OIDC token, npm trades that for a credential good for minutes, and
the exchange also produces a provenance attestation — so there is no `NPM_TOKEN`
in this repository's secrets and there is not meant to be one. The trust is
configured on the package at npmjs.com against this repository and the
*filename* `release.yml`, which is the one thing to remember: renaming that
workflow breaks publishing, and it fails as an authentication error rather than
as a name mismatch.

`gitwarren@0.1.7` was published by hand, because a trusted publisher can only be
configured on a package that already exists and npm has no pre-registration for
one that does not. Nothing else will be.

The **Homebrew formula** is rendered by `scripts/build-homebrew-formula.mjs`
from `packaging/homebrew/gitwarren-cli.rb` in the same job that builds the
tarballs, hashing the exact files it is about to upload, and attached to the
release as `gitwarren-cli.rb`. The tap copies that file rather than computing
anything of its own — a tap that hashed the release separately could hash it
before an asset was re-uploaded, and the result is `SHA256 mismatch` on a user's
machine with nothing on either end to say why.

Cross-building for every platform from one machine is not reliable (Windows
code signing and macOS notarization both need their own host). Run the release
on each platform, or in a CI matrix, and publish to the same tag.

---

## Auto-update

Behaviour: check on launch and every 6 hours, download in the background without
asking, apply on the next restart. The only UI is a quiet banner once a version
is staged, offering an immediate restart. Doing nothing is also fine — it
applies on the next quit either way. A failed check never interrupts the
session; the app keeps running on the current version and retries later.

`src/main/updater.ts` sets `autoDownload` and `autoInstallOnAppQuit` explicitly.
Both are library defaults, but they *are* the requirement, so they should not be
silently inherited.

Auto-update is inert when `app.isPackaged` is false, so development builds don't
try to reach GitHub on every launch.

### Why these targets

| Platform | Target | Silent update |
| --- | --- | --- |
| Windows | NSIS, **per-user** (`perMachine: false`, `oneClick: true`) | ✅ |
| macOS | zip (feed) + dmg (distribution) | ✅ |
| Linux | AppImage | ✅ |
| Linux | deb / rpm | ❌ — needs `apt`/`dnf` and a sudo prompt |

The Windows install is **per-user**, which is what keeps updates free of UAC
prompts. A per-machine install writes to `Program Files` and every update would
raise an elevation dialog — which would defeat "silent" entirely.

`deleteAppDataOnUninstall` is off, so uninstalling does not throw away the
user's repository list.

---

## Code signing and notarization

**Not required for local development builds.** Unsigned builds run fine on your
own machine; electron-builder logs `skipped macOS application code signing` and
carries on.

They *are* required before distributing to anyone else — and specifically,
**auto-update on macOS will not work unsigned**, because Squirrel.Mac validates
the code signature of the downloaded build before swapping it in.

The hardened runtime is already enabled, with entitlements in
`build/entitlements.mac.plist` covering what this app actually needs: JIT for
V8, library validation disabled (the app spawns `git`, and agents spawn the
bundled MCP server), and user-selected file access for repositories on any
volume. `notarize: true` is set in `electron-builder.yml`, which stays inert
until both a signature and Apple credentials exist — see *How the switches
interact* below.

### macOS: one-time setup

Everything here happens once per developer account, not once per release. It
needs a paid Apple Developer Program membership ($99/year).

**1. Create the Developer ID Application certificate.**

This is the certificate for apps distributed outside the Mac App Store. Note
that only the **Account Holder** can create one under an organization
membership — a plain Admin cannot, and the certificate type simply will not
appear in the list for them.

Do this through the developer portal rather than through Xcode. Xcode's
*Settings → Accounts → Manage Certificates* is fewer clicks, but it never asks
which sub-CA to issue under and has been observed picking the legacy one — see
*Check which sub-CA issued it* below, which is worth reading before you start
rather than after.

1. Open **Keychain Access → Certificate Assistant → Request a Certificate From
   a Certificate Authority**. (This works with only the Command Line Tools
   installed; Xcode is not needed for any of it.)
2. Enter your Apple ID email and a common name, leave *CA Email Address* empty,
   choose **Saved to disk** and tick **Let me specify key pair information**.
3. Key size 2048 bits, algorithm RSA. Save the `.certSigningRequest`.
4. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates),
   press **+**, choose **Developer ID Application**, and upload the request.
   Pick the *G2 Sub-CA* profile type when asked.
5. Download the resulting `.cer` and double-click it to install into the login
   keychain.

The private key never leaves your Mac — Apple only ever sees the request. That
also means **Apple cannot re-issue this key if you lose it**, so export the
`.p12` described under *CI secrets* below and keep a copy somewhere durable. An
account is limited to five Developer ID Application certificates, and each is
valid for five years when issued under the current sub-CA.

Confirm the result:

```bash
security find-identity -v -p codesigning
# 1) ABC123... "Developer ID Application: Klarluft B.V. (XXXXXXXXXX)"
#    1 valid identities found
```

The parenthesised code is the **Team ID**. It is also on
[developer.apple.com/account](https://developer.apple.com/account) under
*Membership details*.

**Check which sub-CA issued it.** Apple's original *Developer ID Certification
Authority* intermediate expires on **1 February 2027**, and a leaf certificate
cannot outlive its issuer — so a certificate issued under it is silently
truncated to whatever remains of that date instead of running the full five
years. The *G2 Sub-CA* exists to replace it:

```bash
security find-certificate -c "Developer ID Application" -p |
  openssl x509 -noout -issuer -dates
```

An expiry of exactly `Feb  1 22:12:15 2027 GMT` means the legacy sub-CA issued
it, whatever the portal appeared to offer. Create a fresh one under **G2
Sub-CA** and retire the short one as described below. Note that an account is
limited to five Developer ID Application certificates and a retired one still
occupies a slot until it expires, so it is worth getting this right rather than
iterating.

**If the new certificate shows up as invalid, the intermediate is missing.**
macOS ships the original Developer ID intermediate but not necessarily the G2
one, and a certificate whose chain cannot be completed is not counted as a
valid identity — so `security find-identity -v` stays silent about it while
`security find-identity` (no `-v`) lists it happily. That difference is the
diagnosis:

```bash
security find-identity -p codesigning        # lists it
security find-identity -v -p codesigning     # does not
```

Install the missing link from [Apple's certificate authority
page](https://www.apple.com/certificateauthority/):

```bash
curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
security add-certificates -k ~/Library/Keychains/login.keychain-db DeveloperIDG2CA.cer
```

It grants no new trust — the intermediate is itself issued by Apple Root CA,
which macOS already trusts. It only supplies the link needed to build the chain.

**Do not leave both certificates in the keychain.** Their common names are
identical, so `codesign` cannot tell them apart and refuses to guess:

```
Developer ID Application: ... : ambiguous (matches "Developer ID Application: ..."
and "Developer ID Application: ..." in .../login.keychain-db)
```

That is a build failure, not a silent wrong choice — and pinning
`mac.identity` to a SHA-1 hash does not avoid it, because electron-builder
resolves the hash and then passes `codesign` the *name*. Once the replacement
is confirmed working, delete the old certificate and its private key:

```bash
security delete-identity -Z <sha-1 of the old certificate> ~/Library/Keychains/login.keychain-db
```

**Retiring is all you can do — a Developer ID certificate cannot be revoked
from the portal.** App Store certificates have a *Revoke* button; Developer ID
certificates deliberately do not, because revocation invalidates every app ever
signed with that certificate, timestamps included. It is reserved for a
*compromised* private key and has to be arranged with Apple Product Security by
email. Deleting the key you no longer want is not that situation: with the key
gone the certificate cannot sign anything, and it simply expires on schedule.

**2. Create an app-specific password for notarization.**

Notarization uploads the build to Apple and cannot use your ordinary password
under two-factor auth. At [appleid.apple.com](https://appleid.apple.com) →
*Sign-In and Security → App-Specific Passwords*, generate one and keep the
`xxxx-xxxx-xxxx-xxxx` string.

An App Store Connect API key works instead, via `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. It is the better choice for a shared
CI account, because it is scoped and revocable without touching a person's
Apple ID; the app-specific password is fewer steps for a single developer.

### Building a signed release locally

electron-builder finds the certificate in the login keychain on its own.
Notarization needs the credentials in the environment:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run package
```

Storing the password in the keychain instead keeps it out of the shell history
and out of a dotfile:

```bash
xcrun notarytool store-credentials gitwarren \
  --apple-id "you@example.com" \
  --team-id "XXXXXXXXXX" \
  --password "xxxx-xxxx-xxxx-xxxx"

export APPLE_KEYCHAIN_PROFILE=gitwarren
npm run package
```

Expect the run to take noticeably longer than an unsigned one. Apple's
notarization service usually answers within a few minutes, but it queues, and
each architecture is submitted separately. The log lines to look for are
`signing  file=release/.../GitWarren.app  identityName=Developer ID
Application: ...`, then `notarization successful`. Stapling happens
automatically after that, so the finished app validates on the user's machine
without a network round-trip.

### Verifying a signed build

Worth doing once, on the first signed release, rather than discovering a
problem from a user:

```bash
APP="release/0.1.0/mac-arm64/GitWarren.app"

# The signature is intact and covers every nested binary.
codesign --verify --deep --strict --verbose=2 "$APP"

# Signed by the right authority, with the hardened runtime on.
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'
# Authority=Developer ID Application: Klarluft B.V. (XXXXXXXXXX)
# TeamIdentifier=XXXXXXXXXX
# flags=0x10000(runtime)

# The notarization ticket is stapled to the bundle.
xcrun stapler validate "$APP"

# What Gatekeeper will decide on the user's machine.
spctl -a -vvv -t install "$APP"
# source=Notarized Developer ID
```

`source=Notarized Developer ID` is the line that matters. Anything else — most
often `source=Unnotarized Developer ID` — means the signature landed but the
notarization did not, and the download will still be refused.

### CI secrets

The release workflow reads five optional secrets. Setting them switches the
GitHub Actions build from ad-hoc to properly signed and notarized; leaving them
unset keeps the existing unsigned behaviour.

Export the certificate *with its private key* from Keychain Access — select the
**Developer ID Application** entry under *My Certificates*, right-click →
*Export*, choose **Personal Information Exchange (.p12)**, and set a password.
Then:

**Pipe the values in; do not paste them.** A base64 `.p12` runs to several
thousand characters, and many terminals silently truncate a paste of that size
into an interactive prompt. The result is a secret that looks set and fails
much later as `MAC verification failed during PKCS12 import (wrong password?)`
— which reads as a password problem when the certificate is what got cut short.

The certificate pair has to be stored as one verified unit, so
[`scripts/set-signing-secrets.sh`](../scripts/set-signing-secrets.sh) does it:

```bash
./scripts/set-signing-secrets.sh ~/Documents/certificate.p12
```

It prompts for the password without echoing it, refuses to store anything
unless that password actually opens the `.p12` *and* a private key is inside,
and then sets both secrets from exactly those bytes. The remaining three are
short enough to paste at a prompt, which also keeps them out of shell history:

```bash
gh secret set APPLE_ID                    # you@example.com
gh secret set APPLE_APP_SPECIFIC_PASSWORD # xxxx-xxxx-xxxx-xxxx
gh secret set APPLE_TEAM_ID               # XXXXXXXXXX
```

Setting the pair by hand is where this goes wrong, in two ways that produce an
identical error. A base64 `.p12` runs to several thousand characters and many
terminals silently truncate a paste that long, and `echo "$pw" | gh secret set`
stores the trailing newline as part of the password. Both surface much later as
`MAC verification failed during PKCS12 import (wrong password?)`, which reads
as a bad certificate rather than a badly stored one. If you do set them by
hand, pipe the base64 from the file and use `printf '%s'` rather than `echo`.

The release workflow checks that `CSC_LINK` and `CSC_KEY_PASSWORD` agree before
it builds anything, so a mistake here surfaces in seconds with a message naming
the cause rather than several minutes in. The secret names are unchanged, and
`scripts/set-signing-secrets.sh` still sets them.

**The Apple certificate never reaches a Windows runner.** electron-builder's
Windows packager reads `CSC_LINK` and `CSC_KEY_PASSWORD` too, and handed the
Apple pair it tries to Authenticode-sign an `.exe` with a Developer ID
certificate, failing with `Cannot extract publisher name from code signing
certificate`. Windows carries no certificate of its own to confuse matters:
it signs through Azure Artifact Signing, which keeps the private key, so the
only Windows secrets are the three `AZURE_*` credentials. See *Windows* below.

**On macOS the workflow builds the keychain itself** and never exports
`CSC_LINK`. Setting it would send electron-builder down its own
`createKeychain` path, which imports the certificate and then runs

```
security set-key-partition-list -S apple-tool:,apple: -s -k <password>
```

passing the *certificate* password to a flag that means the *keychain*
password — the keychain's own password is a random value generated a few lines
earlier in `app-builder-lib/out/codeSign/macCodeSign.js` and never reused
there. macOS rejects it and the build dies several minutes in with

```
security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
```

which reads as a bad certificate even when the certificate is perfectly good.
It is unchanged as of electron-builder 26.16.0, so upgrading is not the fix.
The *Import the Apple certificate into a keychain* step therefore creates,
unlocks and populates a temporary keychain itself — passing the keychain
password where it belongs — verifies a Developer ID Application identity
actually landed in it, and hands electron-builder `CSC_KEYCHAIN`, which
`macPackager` consults only when `CSC_LINK` is absent. That step also does the
`CSC_LINK`/`CSC_KEY_PASSWORD` agreement check, so a badly stored secret still
surfaces in seconds rather than several minutes in.

The signing secrets go through `$GITHUB_ENV` rather than a step-level `env:`
block. An absent secret is not an unset variable in GitHub Actions — it is an
empty string, and a step-level `env:` would override what the export step
writes. The loop in *Export the signing secrets that exist* skips empty values
so the unset case stays genuinely unset, which is what lets every credential
here be optional.

### How the switches interact

Three independent things decide what a macOS build comes out as, which is why
none of them has to be toggled per build:

| Certificate | Apple credentials | Result |
| --- | --- | --- |
| absent | either way | ad-hoc signed by `scripts/adhoc-sign.mjs`, not notarized |
| present | absent | signed, `skipped macOS notarization` warning, not notarized |
| present | present | signed, notarized, stapled |

Notarization is only attempted after a real signature succeeds, so `notarize:
true` is harmless on a machine with no certificate — the code path is never
reached. `scripts/adhoc-sign.mjs` stands down as soon as `CSC_KEYCHAIN` or
`CSC_LINK` is set, or a Developer ID identity is in the keychain, so it never
fights with the real signature.

Windows has one switch rather than three, and it is the presence of
`AZURE_CLIENT_ID`:

| Azure credentials | Result |
| --- | --- |
| absent | unsigned installer, no `azureSignOptions` passed, build succeeds |
| present | Authenticode-signed and timestamped by Azure Artifact Signing |

### Windows

Windows signs through [Azure Artifact
Signing](https://azure.microsoft.com/en-us/products/artifact-signing) — the
service Microsoft renamed from Trusted Signing in 2026 — at $9.99/month for up
to 5,000 signatures.

The alternative was an EV certificate. Since June 2023 an OV code-signing key
must live on a hardware token or an HSM, which means a courier, a physical
device, and no clean way to sign from a CI runner. A managed service keeps the
key on Microsoft's side and authenticates with an ordinary client secret, so a
GitHub Actions runner can sign without anything being mailed anywhere.

Eligibility used to be the obstacle: the service was limited to US and Canadian
organizations with three or more years of trading history. At GA in 2026 that
opened to EU, UK and several other organizations and the history requirement was
dropped, which is what made this route possible for a Dutch B.V. Individual
developers are still US/Canada only, so this runs through Klarluft B.V. as an
organization.

**The resources**, all under contact@klarluft.com:

| Thing | Value |
| --- | --- |
| Tenant | `01a162b2-9903-4fcc-ba5b-324524440547` (NL) |
| Subscription | `da65adba-22ab-436a-9f62-66d82c862188` |
| Signing account | `klarluft-bv`, resource group `klarluft-signing`, North Europe |
| Endpoint | `https://neu.codesigning.azure.net/` |
| Certificate profile | `klarluft-public-trust` (Public Trust) |
| Certificate subject | `CN=Klarluft B.V., O=Klarluft B.V., L=Rotterdam, S=Zuid-Holland, C=NL` |

**The secrets** are `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
`AZURE_CLIENT_SECRET`, belonging to the `gitwarren-release-signing` app
registration. It holds the *Artifact Signing Certificate Profile Signer* role
scoped to the certificate profile rather than to the whole account, so adding a
second profile later does not silently widen what this credential can sign.
electron-builder picks the three up through Azure's `EnvironmentCredential`.

**The client secret expires.** It was issued on 12 September 2026 with a
two-year life, so it lapses around September 2028. The failure mode is a
release build dying at the signing step with an authentication error and
nothing in the repository explaining why, so it is worth a calendar entry.
Rotate it with

```bash
az ad app credential reset --id <appId> --years 2 --query password -o tsv \
  | gh secret set AZURE_CLIENT_SECRET
```

piping it straight into `gh` so the value is never displayed or written to
disk.

**Certificates last three days.** This is not a misconfiguration — Artifact
Signing issues short-lived certificates and rotates them continuously. It is
also why the RFC3161 timestamp is load-bearing rather than optional: the
timestamp proves the binary was signed while its certificate was valid, so the
signature stays good long after that certificate expires. Without one every
build would stop verifying within 72 hours. electron-builder defaults to
Microsoft's `http://timestamp.acs.microsoft.com`; leave it alone.

**`publisherName` must equal the certificate's common name exactly.**
`verifyUpdateCodeSignature` defaults to true, so electron-updater checks every
downloaded update against that string. A mismatch produces an app that installs
perfectly and then silently refuses every auto-update — worse than shipping
unsigned, and invisible until users stop receiving releases. Read it back from
Azure rather than retyping it:

```bash
az rest --method get --url "https://management.azure.com/subscriptions/da65adba-22ab-436a-9f62-66d82c862188/resourceGroups/klarluft-signing/providers/Microsoft.CodeSigning/codeSigningAccounts/klarluft-bv/certificateProfiles/klarluft-public-trust?api-version=2024-09-30-preview" \
  --query "properties.certificates[0].subjectName" -o tsv
```

**The signing configuration is not in `electron-builder.yml`.** It is passed by
the *Build and publish* step of `release.yml` instead. `winPackager` switches to
the Azure signing manager the moment `win.azureSignOptions` exists and never
checks whether credentials are present, so putting it in the config file would
make every unsigned local Windows build fail at the signing step. Passing it
from the workflow keeps `npm run package` working on a developer's machine with
no Azure access at all.

Signing also only runs on a Windows runner: electron-builder drives it through
the `TrustedSigning` PowerShell module, which it installs into the runner's
`CurrentUser` scope on first use. The release matrix already builds Windows on
`windows-latest`, so this costs nothing.

**SmartScreen reputation still has to accrue.** These are OV-class
certificates, so the *"Windows protected your PC"* warning fades as downloads
accumulate against the publisher rather than disappearing with the first signed
release. Only an EV certificate buys immediate clearance. Updates were never
affected either way — electron-updater verifies the sha512 from the manifest,
not a signature.

### Linux

AppImage needs no signing.

### Releasing before the certificates exist

The release pipeline is complete without any of the above. Every signing secret
is optional, so a tag pushed with none of them set still produces installers for
all three platforms — each platform simply comes out unsigned. That property is
worth preserving deliberately rather than by accident: it is why the Windows
signing configuration is passed from the workflow instead of living in
`electron-builder.yml`, where its mere presence would make an uncredentialled
build fail.

What each platform costs while unsigned:

| Platform | Installs? | Auto-updates? |
| --- | --- | --- |
| Linux | Yes, unchanged | Yes, unchanged |
| Windows | Yes, past a SmartScreen warning | Yes |
| macOS | Yes, past a manual Gatekeeper override | **No** |

Linux is unaffected — an AppImage is never signed. Windows shows *"Windows
protected your PC"* until SmartScreen has built reputation against the
publisher, but installs and updates work throughout. Note that signing alone
does not clear that warning immediately: with an OV-class certificate, which is
what Artifact Signing issues, reputation accrues over downloads.

macOS is the one that is genuinely degraded, in two ways. Gatekeeper refuses a
downloaded build that is not notarized, and the user has to allow it explicitly
in **System Settings → Privacy & Security**, where a *GitWarren was blocked*
row appears after the first launch attempt. Right-click → Open no longer works
as a bypass; Apple removed that in macOS Sequoia. Stripping the quarantine
attribute by hand does the same thing:

```bash
xattr -d com.apple.quarantine /Applications/GitWarren.app
```

Both are fine for a developer trying the app deliberately, and both are far too
much to ask of anyone else.

The second cost is the one to plan around: **auto-update does not work at all on
an unsigned macOS build**, so anyone who installs one is on a dead-end version.
They will not be moved forward by the updater and will have to download the
first signed release by hand. Publishing unsigned macOS artifacts as a
pre-release, rather than as a headline version, keeps that population small.

A local build runs with none of this friction, because a bundle you produced
yourself carries no `com.apple.quarantine` attribute and Gatekeeper is never
consulted. That is why `npm run package` output opens by double-clicking while
the same file downloaded from a release does not.

`afterPack` runs [`scripts/adhoc-sign.mjs`](../scripts/adhoc-sign.mjs), which
ad-hoc signs macOS builds whenever no Developer ID is present. This is not a
substitute for signing — Gatekeeper still refuses the download — but it changes
*how* it refuses. Packaging invalidates the seal on the linker signature
Electron ships with, and macOS reports a bundle whose seal does not match as
**damaged**, which reads as malware rather than as the ordinary unidentified
developer users know how to allow. Re-signing ad-hoc makes the signature
self-consistent again, so the refusal is the honest one and the Privacy &
Security override works.

---

## Social preview

The card GitHub shows when this repository is unfurled — in Slack, on X, on
LinkedIn, in iMessage — is `docs/social-preview.png`.

It is **not** picked up from the repository automatically. GitHub has no API
for it, so it is uploaded by hand, once, and then stays put:

**Settings → General → Social preview → Edit → Upload an image.**

GitHub asks for 1280×640 and rejects anything over 1 MB.

To change it, edit the design in `scripts/build-social-preview.mjs` and
re-render:

```bash
node scripts/build-social-preview.mjs
```

That writes every variant to `screenshots-out/` (gitignored) and copies the one
named by `CHOSEN` to `docs/social-preview.png`. The upload is still manual.

The script renders HTML in headless Chrome at 2× and downsamples, so the type
is supersampled rather than aliased. The palette and the five vendored fonts in
`scripts/social-preview/fonts/` are the site's, so the card and
[gitwarren.com](https://gitwarren.com) stay the same brand. Note that the site
builds its own Open Graph image separately, by cropping the hero screenshot —
these two are unrelated and both need updating if the branding moves.

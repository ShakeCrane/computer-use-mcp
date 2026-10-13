# Native package releases

The main `@zavora-ai/computer-use-mcp` package declares six native packages as
optional dependencies, pinned to exactly its own version. Each native package
contains its manifest, MIT license and one `.node` binary, with no install script
or runtime dependencies. Its `os` and `cpu` fields let npm select the host target.

| npm package suffix | Rust target | Cargo release artifact |
| --- | --- | --- |
| `darwin-arm64` | `aarch64-apple-darwin` | `libcomputer_use_napi.dylib` |
| `darwin-x64` | `x86_64-apple-darwin` | `libcomputer_use_napi.dylib` |
| `win32-x64` | `x86_64-pc-windows-msvc` | `computer_use_napi.dll` |
| `win32-arm64` | `aarch64-pc-windows-msvc` | `computer_use_napi.dll` |
| `linux-x64` | `x86_64-unknown-linux-gnu` | `libcomputer_use_napi.so` |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | `libcomputer_use_napi.so` |

`build-native` compiles the existing Rust N-API 9 cdylib with
`cargo build --release --target <target>` and copies
`native/target/<target>/release/<artifact>` to
`computer-use-napi.<platform>-<arch>.node` at the repository root.
Linux builds use the existing GNU/X11 targets; these names do not promise musl
compatibility or add a new platform ABI.

## Compatibility and bundlers

The resolution order remains:

1. An existing file at `COMPUTER_USE_NATIVE_PATH`.
2. `@zavora-ai/computer-use-mcp-<platform>-<arch>/computer-use-napi.<platform>-<arch>.node`.
3. The platform binary bundled in the main package.
4. The generic `computer-use-napi.node` bundled in the main package.

The universal main tarball retains all six binaries during 7.x. Installs using
`--omit=optional`, or encountering an unavailable optional package, still use
the bundled native addon. An explicit native path retains its existing behavior.
Bundlers can keep the matching native package external and ship its `.node`
file separately, or use the existing path override when staging a binary.

## Versioning and packing

Use `npm version <version> --no-git-tag-version` to update the root version and
run the version hook. The hook invokes `prepare:packages -- --sync-only`, which
updates all six manifests, root optional dependency pins and native lockfile
entries. Commit those files together. `npm run prepare:packages -- --sync-only`
also synchronizes a version edited by hand, without requiring native artifacts.

Before the package names exist on npm, `npm install --package-lock-only` drops
them from the lockfile. Run the synchronization command after regenerating the
lockfile: it records the version, public tarball URL, license, `os`, `cpu` and
optional status from the local manifests. It does not fabricate an integrity
hash for an unpublished version, and preserves registry integrity for unchanged
versions. This lets `npm ci` omit unavailable optional packages without rejecting
an incomplete lockfile.

`npm run prepare:packages` copies available root binaries and the license into
the corresponding packages. It removes stale package binaries when the matching
root artifact is missing. `npm run pack:platforms` requires all six nonempty root
artifacts, validates all manifests before preparing any package, packs each with
`--ignore-scripts`, and verifies that each tarball contains exactly its manifest,
license and native addon. It writes the tarballs and their name/version/integrity
inventory to `release/platform/`. Binaries and generated licenses are ignored by
Git.

## CI and staged publishing

The existing `.github/workflows/ci.yml` release flow gains a `platform-packages`
job after `build-native`. It packs all six targets and uploads the tarballs as
`native-platform-packages`. The existing macOS arm64, Windows x64/arm64 and Linux
x64/arm64 test jobs install these exact tarballs through a temporary local
registry and load the addon through the main package. The test checks automatic
host selection, override precedence, loading with bundled binaries removed,
and fallback when optional packages are omitted or unavailable. Metadata and
contents are checked for all six targets, including cross-compiled macOS x64.

After all existing release gates pass, the upstream main-push release job:

1. Downloads the tested native tarballs and all six root binaries.
2. Packs and verifies the universal main package and exact optional version pins.
3. Attests the six binaries and all seven tarballs; retains the main SBOM
   attestation and uploads immutable release evidence.
4. Validates every native tarball's integrity and checks npm for existing versions.
   Identical published versions are skipped; conflicting bytes or registry errors
   fail the release before any new native package is staged.
5. Stages all six native packages with `npm stage publish --access public
   --provenance`, then stages the main tarball with the existing approval flow.

Only this upstream repository can stage releases; fork and PR workflows only
build and test. An already pending staged native version is reported for review,
without trying to overwrite it. A partial staging failure can be retried; npm
publication is not atomic across seven packages. Review the pending tarballs
against the matching release evidence, approve all six native packages first,
then approve the main package. Neither the workflow nor the scripts approve
packages automatically. Existing published main versions remain immutable;
a version bump is required for the new optional dependency declaration to reach
users of the main package.

## First release of new package names

npm supports creating new names through staged publishing, but trusted
publishing must be configured separately for each name after its creation.
See [npm's new-package announcement](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages/)
and [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

For the first release, a maintainer can provide the temporary repository secret
`NPM_NATIVE_STAGE_TOKEN`: a granular **stage-only** token authorized to create
the six names under `@zavora-ai`. It is used only in the native staging step;
the main package continues to use its existing OIDC configuration. Every first
tarball is still staged with provenance from GitHub Actions and requires
maintainer approval. Staging creates npm's `0.0.0-stage` placeholder; the real
native version becomes installable only after approval.

Configure each newly created native package's trusted publisher with organization
`zavora-ai`, repository `computer-use-mcp`, workflow filename `ci.yml`, and staged
publishing permission. Approve the six matching versions, remove the temporary
secret and revoke the bootstrap token. Subsequent runs use OIDC with
`id-token: write`, without a persistent npm write token. npm's required CLI
version is 11.15.0 or later, with Node 22.14.0 or later; the release job uses
Node 24. A newly configured trusted publisher must be validated within npm's
documented expiry window.

# @provod-ai/cli

This package installs and launches the standalone native [Provod CLI](https://provod.ai).

```bash
npm install -g @provod-ai/cli
provod setup
```

The package requires Node.js 18.18 or newer and npm for installation and for the small `provod` launcher. The Provod application itself is a standalone native executable downloaded from the GitHub Release whose `v<version>` exactly matches this package version.

The installer supports macOS arm64/x64 and Linux arm64/x64. Windows support is currently unavailable. It downloads the deterministic platform archive and `SHA256SUMS` over HTTPS, always verifies SHA-256, validates the archive allowlist, and atomically installs the executable package-locally under `vendor/`.

Cosign is not required by default. Checksums detect corruption but do not authenticate the publisher if both archive and manifest are replaced; default installation trusts HTTPS and the GitHub release account, not verified Sigstore provenance. Published signatures remain available.

For optional verification, install trusted Cosign independently (tested with v2.6.1), then run `PROVOD_VERIFY_SIGNATURE=1 npm install -g @provod-ai/cli`. Only `0` (default) and `1` are accepted. Opt-in verification checks the sibling Sigstore bundle against the exact `native-release.yml@refs/tags/v<version>` identity in `provod-ai/cli-source` and GitHub Actions OIDC issuer. Missing Cosign, missing bundles and invalid signatures fail closed, without checksum-only fallback. The installer never downloads or executes a verifier bootstrap.

**Release transition:** npm `0.1.1` installation needs no Cosign, but its embedded `provod update` still requires it. No-Cosign self-update requires a new matching native/npm release; then migrate once with `npm install -g @provod-ai/cli@X.Y.Z` (replace the placeholder with that release). Old executables cannot receive this fix merely by setting an environment variable. Future updates check native SHA-256 and wrapper SHA-512 by default; `PROVOD_VERIFY_SIGNATURE=1 provod update --yes` additionally requires exact native/npm tag provenance and fails closed. npm `0.1.1` has main-ref provenance and is incompatible with strict tag-pinned verification. Future npm publication is tag-event-only; no main-ref recovery or republishing immutable versions.

Release downloads come only from `https://github.com/provod-ai/cli/releases/`; there is no production URL override and this package has no runtime dependencies.

Preview signing policy: macOS binaries are ad-hoc signed rather than Apple Developer ID signed/notarized. Gatekeeper may warn or block execution. Checksums and Sigstore release-approval provenance verify approved external artifact identity and integrity, not CI construction or an operating-system-trusted publisher. ARM64 targets are native; macOS x64 uses Rosetta and Linux x64 Docker emulation. The signed approval distinguishes the original producer source from the later workflow/approval commit.

See the [public CLI repository](https://github.com/provod-ai/cli) for commands, manual installation, release verification, support, and licensing.

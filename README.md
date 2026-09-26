# Provod CLI

[![release](https://img.shields.io/github/v/release/provod-ai/cli?style=flat-square)](https://github.com/provod-ai/cli/releases)
[![platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-111111?style=flat-square)](#supported-platforms)
[![license](https://img.shields.io/github/license/provod-ai/cli?style=flat-square)](./LICENSE)

Connect [Provod](https://provod.ai) to your AI coding agents from one command. The CLI configures Provod models and the hosted MCP server, manages workspace API keys, and reports account balance across 21 supported clients.

The CLI application ships as a standalone native executable. The direct installers do not require Node.js; the npm installation option requires Node.js 18.18 or newer and npm for its installer and launcher.

> **Preview:** the CLI is pre-release and no public binary has been published yet. Installation commands below become usable with the first release.

> **Temporary signing policy:** macOS binaries are ad-hoc signed, not Apple Developer ID signed or notarized, so Gatekeeper may warn or block first launch. Windows support is currently unavailable. SHA-256 and Sigstore provenance verify the downloaded build, but they do not establish an operating-system-trusted publisher. Apple Developer ID signing and notarization remain pending.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Examples](#examples)
- [Supported agents](#supported-agents)
- [Commands](#commands)
- [Supported platforms](#supported-platforms)
- [Release verification](#release-verification)
- [Updating](#updating)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Support](#support)
- [License](#license)

## Install

### npm

Requires Node.js 18.18 or newer and npm. The package version maps exactly to GitHub Release `v<version>`; installation downloads, verifies, and stores the matching native executable inside the package.

```bash
npm install -g @provod-ai/cli
```

### macOS / Linux — curl

```bash
curl -fsSL https://raw.githubusercontent.com/provod-ai/cli/main/install.sh | sh
```

### macOS / Linux — wget

```bash
wget -qO- https://raw.githubusercontent.com/provod-ai/cli/main/install.sh | sh
```

The installer automatically downloads the latest release to `~/.local/bin/provod`. Override the destination with `PROVOD_INSTALL_DIR`.

### Windows

Windows support is currently unavailable. Windows CI and release builds are disabled; the PowerShell and npm installers fail before downloading or changing files. Use macOS or Linux.

### Manual

Download the archive for your OS and architecture from [Releases](https://github.com/provod-ai/cli/releases), verify it against `SHA256SUMS`, extract it, and place `provod` in your `PATH`.

## Quickstart

Run the interactive setup. Provod detects supported clients and opens your browser for authorization:

```bash
provod setup
```

Check the authenticated installation:

```bash
provod status
```

## Examples

Configure one agent explicitly:

```bash
provod setup --global --agent claude-code --model claude-code=claude-sonnet-4.6
```

Configure several agents in one transaction:

```bash
provod setup --global \
  --agent hermes \
  --agent codex \
  --agent opencode \
  --model hermes=claude-sonnet-4.6 \
  --model codex=gpt-5.4 \
  --model opencode=gpt-5.4
```

Use the integrity-checked recommended models without interactive prompts:

```bash
provod setup --global --yes
```

Inspect workspace usage and API keys:

```bash
provod balance --json
provod api-keys list --limit 50 --json
provod api-keys create --name deploy --budget month=100.00000000
```

Run the stdio bridge to the hosted Provod MCP server:

```bash
provod mcp
```

## Supported agents

`provod setup` can configure any combination of these 21 clients:

- Hermes Agent
- Claude Code
- Codex CLI
- OpenCode
- Kilo Code
- Crush
- Qwen Code
- Mistral Vibe
- Zed
- ForgeCode
- Goose
- Grok Build
- Junie CLI
- Cline
- GitHub Copilot CLI
- Deep Agents Code
- Factory Droid
- Kimi Code CLI
- omp
- OpenClaw
- OpenHands CLI

Use repeatable `--agent <name>` and `--model <agent>=<model>` flags for deterministic non-interactive setup, or omit them on a TTY to select agents and models interactively.

## Commands

| Command | Description |
|---|---|
| `provod setup` | Authorize Provod and configure one or more coding agents |
| `provod status` | Read the authenticated installation status |
| `provod api-keys` | Create, list, inspect, update, or revoke workspace API keys |
| `provod balance` | Show the workspace balance |
| `provod mcp` | Bridge stdio to the hosted Provod MCP service |
| `provod --help` | Show command help |
| `provod --version` | Show the installed version |

`status`, `balance`, and API-key subcommands accept `--json`. `setup` writes its result as machine-readable JSON, while `mcp` reserves stdout for JSON-RPC. Run `provod <command> --help` for command-specific flags.

## Supported platforms

| Platform | Architecture | Release asset |
|---|---|---|
| macOS | Apple silicon | `provod-v<version>-darwin-arm64.tar.gz` |
| macOS | Intel | `provod-v<version>-darwin-x64.tar.gz` |
| Linux | arm64 | `provod-v<version>-linux-arm64.tar.gz` |
| Linux | x64 | `provod-v<version>-linux-x64.tar.gz` |

## Release verification

The POSIX and npm installers require a trusted Cosign on PATH (tested with v2.6.1). Install it independently from the official Sigstore distribution; the installers never download a verifier or bypass verification. They download the platform archive, `SHA256SUMS` and its Sigstore bundle, require exactly the four same-version platform archive entries listed above, verify SHA-256 and the exact workflow/tag signature, and only then replace the installed executable. Each release contains exactly four archives, four sibling provenance bundles, and `SHA256SUMS` (nine files). Older five-platform manifests are not accepted by these installers.

Each archive has a sibling `<archive>.sigstore.json` bundle containing a keyless release-approval predicate in SLSA v1 format. These binaries are built externally, not in GitHub Actions: macOS ARM64 and Linux ARM64 are native; macOS x64 is tested under Rosetta and Linux x64 under Docker emulation, not native Intel hardware. The `external-artifact-approval/v1` build type binds the approved archive hashes, original production source commit/fingerprint, separate approval workflow commit, and execution modes. It is not a claim of a hermetic CI build or a SLSA build level. To verify it with [Cosign](https://docs.sigstore.dev/cosign/verifying/verify/):

```bash
VERSION=x.y.z
ASSET="provod-v${VERSION}-linux-x64.tar.gz"

cosign verify-blob-attestation \
  --bundle "$ASSET.sigstore.json" \
  --new-bundle-format=true \
  --type slsaprovenance1 \
  --certificate-identity "https://github.com/provod-ai/cli-source/.github/workflows/native-release.yml@refs/tags/v$VERSION" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$ASSET"
```

Do not weaken the certificate identity to only an organization or repository match. The exact approval workflow and release tag are part of the trust policy.

Check the release notes before installing. Preview releases currently follow the temporary signing policy above: macOS is ad-hoc signed; Windows support is unavailable. Checksums and release-approval provenance do not provide Apple notarization, Microsoft Authenticode, or operating-system publisher trust.

This repository is a binary-only distribution channel with independent Git history. It contains installers, public documentation, and release assets—not the private source tree or source maps. The executable is a Node.js Single Executable Application whose embedded JavaScript can be inspected and extracted. Binary-only distribution does not provide source-code confidentiality or anti-reverse-engineering protection; it keeps the private source tree, source maps, and Git history out of this public repository.

## Updating

Run the same platform install command again. It resolves the latest release, verifies its checksum, and replaces the executable atomically.

The preview does not expose a separate `update` command.

## Uninstall

The preview does not expose an automatic `uninstall` command. Remove the executable manually:

```bash
rm ~/.local/bin/provod
```

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\Provod\provod.exe"
```

Removing the executable does not revert agent configuration or revoke the Provod authorization. Review the affected client configuration before removing Provod-owned entries.

## Troubleshooting

### `provod: command not found`

Ensure the installation directory is present in `PATH`, then open a new shell.

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Unsupported platform

Use one of the four targets listed under [Supported platforms](#supported-platforms).

### Setup is blocked after an interrupted run

The CLI fails closed when another operation may still own its state lock. First prove that no Provod setup, status, or MCP credential operation is running. Then follow the recovery guidance printed by the CLI; do not remove a lock based only on its age or recorded process ID.

### Legacy keyring installation

A session stored only by an older CLI in the OS keyring cannot be migrated automatically. Use that older CLI to clean up or revoke the installation, then run `provod setup` again to authenticate into the private-file credential store.

## Support

- Report CLI and release problems in [GitHub Issues](https://github.com/provod-ai/cli/issues).
- Product information and contact details: [provod.ai](https://provod.ai).

## License

[MIT](./LICENSE)

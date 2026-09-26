#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'usage: install.sh [version]' >&2
  exit 2
}

[ "$#" -le 1 ] || usage
requested_version=${1:-}
version=${requested_version#v}

valid_version() {
  candidate=$1
  case "$candidate" in
    ''|*[!0-9A-Za-z.-]*) return 1 ;;
  esac
  core=${candidate%%-*}
  suffix=''
  if [ "$core" != "$candidate" ]; then
    suffix=${candidate#*-}
    case "$suffix" in ''|.*|*.|*..*) return 1 ;; esac
  fi
  old_ifs=$IFS
  IFS=.
  # Intentional field splitting validates the three dot-separated components.
  # shellcheck disable=SC2086
  set -- $core
  IFS=$old_ifs
  [ "$#" -eq 3 ] || return 1
  for part do
    case "$part" in
      ''|*[!0-9]*|0[0-9]*) return 1 ;;
    esac
  done
  if [ -n "$suffix" ]; then
    old_ifs=$IFS
    IFS=.
    # Intentional field splitting validates prerelease identifiers.
    # shellcheck disable=SC2086
    set -- $suffix
    IFS=$old_ifs
    for identifier do
      case "$identifier" in
        ''|*[!0-9A-Za-z-]*) return 1 ;;
        *[!0-9]*) ;;
        0) ;;
        0*) return 1 ;;
      esac
    done
  fi
}

if [ "$#" -eq 1 ]; then
  valid_version "$version" || usage
fi

MAX_ARCHIVE_BYTES=104857600
MAX_METADATA_BYTES=1048576

fetch() {
  url=$1
  output=$2
  limit=$3
  case "$url" in
    https://*) ;;
    *) printf '%s\n' 'refusing non-HTTPS download' >&2; exit 1 ;;
  esac
  rm -f "$output"
  if command -v curl >/dev/null 2>&1; then
    effective=$(curl --disable --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --max-redirs 3 --connect-timeout 10 --max-time 120 --retry 3 \
      --max-filesize "$limit" --silent --show-error --output "$output" --write-out '%{url_effective}' "$url") || {
        rm -f "$output"
        printf '%s\n' 'download failed' >&2
        exit 1
      }
    case "$effective" in https://*) ;; *) rm -f "$output"; printf '%s\n' 'download redirected to a non-HTTPS URL' >&2; exit 1 ;; esac
  elif command -v wget >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin) download_limit_blocks=$((limit / 1024)) ;;
      *) download_limit_blocks=$((limit / 512)) ;;
    esac
    (
      ulimit -f "$download_limit_blocks"
      exec wget --quiet --no-config --no-netrc --https-only --max-redirect=3 --timeout=120 --tries=3 --output-document="$output" "$url"
    ) || {
      rm -f "$output"
      printf '%s\n' 'download failed' >&2
      exit 1
    }
  else
    printf '%s\n' 'curl or wget is required' >&2
    exit 1
  fi
  [ -f "$output" ] || { printf '%s\n' 'download produced no file' >&2; exit 1; }
  bytes=$(wc -c < "$output" | tr -d ' ')
  [ "$bytes" -le "$limit" ] || { rm -f "$output"; printf '%s\n' 'download exceeds size limit' >&2; exit 1; }
}

fetch_stdout() {
  url=$1
  temporary_stdout=$(mktemp "${TMPDIR:-/tmp}/provod-latest.XXXXXX")
  fetch "$url" "$temporary_stdout" "$MAX_METADATA_BYTES"
  cat "$temporary_stdout"
  rm -f "$temporary_stdout"
}

if [ -z "$version" ]; then
  tag=$(fetch_stdout 'https://api.github.com/repos/provod-ai/cli/releases/latest' |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"[:space:]]*\)".*/\1/p' |
    sed -n '1p')
  version=${tag#v}
  [ -n "$version" ] || {
    printf '%s\n' 'failed to determine the latest Provod CLI release' >&2
    exit 1
  }
fi

valid_version "$version" || {
  printf '%s\n' 'latest release returned an invalid version' >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) printf 'unsupported operating system: %s\n' "$(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) printf 'unsupported architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
esac

asset="provod-v${version}-${os}-${arch}.tar.gz"
base_url="${PROVOD_RELEASE_BASE_URL:-https://github.com/provod-ai/cli/releases/download}/v${version}"
destination="${PROVOD_INSTALL_DIR:-$HOME/.local/bin}"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/provod-install.XXXXXX")
staged=''
backup=''
had_existing=0
replacement_armed=0
committed=0
in_destination=0
lock_claim=''
lock_token="$$.$temporary"
cleanup() {
  status=$?
  rollback_failed=0
  if [ "$in_destination" -eq 1 ]; then
    if [ "$committed" -ne 1 ] && [ "$replacement_armed" -eq 1 ] && [ -n "$staged" ] && [ ! -e "$staged" ]; then
      if [ "$had_existing" -eq 1 ]; then
        if [ -n "$backup" ] && [ -f "$backup" ]; then
          if mv -f "$backup" provod; then backup=''; else rollback_failed=1; fi
        else
          rollback_failed=1
        fi
      elif ! rm -f provod; then
        rollback_failed=1
      fi
    fi
    if [ "$committed" -ne 1 ] && [ -n "$backup" ] && [ -f "$backup" ] &&
       { [ "$replacement_armed" -ne 1 ] || [ -e "$staged" ]; }; then
      rm -f "$backup"
      backup=''
    fi
    if [ "$committed" -eq 1 ] && [ -n "$backup" ] && [ -f "$backup" ]; then
      rm -f "$backup"
      backup=''
    fi
    [ -z "$staged" ] || rm -f "$staged"
    if [ -f .provod.install.lock ] &&
       [ "$(cat .provod.install.lock 2>/dev/null || :)" = "$lock_token" ]; then
      rm -f .provod.install.lock
    fi
    if [ -n "$lock_claim" ] && [ -f "$lock_claim" ] &&
       [ "$(cat "$lock_claim" 2>/dev/null || :)" = "$lock_token" ]; then
      rm -f "$lock_claim"
    fi
  fi
  rm -rf "$temporary"
  if [ "$rollback_failed" -eq 1 ] && [ -n "$backup" ] && [ -e "$backup" ]; then
    printf 'rollback failed; preserved backup at: %s/%s\n' "$display_destination" "$backup" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fetch "$base_url/$asset" "$temporary/$asset" "$MAX_ARCHIVE_BYTES"
fetch "$base_url/SHA256SUMS" "$temporary/SHA256SUMS" "$MAX_METADATA_BYTES"

expected=$(awk -v expected_asset="$asset" -v version="$version" '
  BEGIN {
    found=0; bad=0
    split("darwin-arm64 darwin-x64 linux-arm64 linux-x64", targets, " ")
    for (i in targets) allowed["provod-v" version "-" targets[i] ".tar.gz"]=1
  }
  {
    # Older mawk lacks interval expressions such as {64}; check width explicitly.
    if (length(substr($0, 1, 64)) != 64 || substr($0, 1, 64) ~ /[^0-9a-f]/ ||
        substr($0, 65, 2) != "  " || !allowed[substr($0, 67)]) {
      bad=1
      next
    }
    digest=substr($0, 1, 64)
    name=substr($0, 67)
    seen[name]++
    if (seen[name] > 1) bad=1
    if (name == expected_asset) { found++; value=digest }
  }
  END { if (bad || found != 1 || NR != 4) exit 1; print value }
' "$temporary/SHA256SUMS") || {
  printf '%s\n' 'release checksum manifest is malformed, duplicated, or ambiguous' >&2
  exit 1
}
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset")
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset")
else
  printf '%s\n' 'shasum or sha256sum is required' >&2
  exit 1
fi
actual=${actual%% *}
[ "$actual" = "$expected" ] || { printf '%s\n' 'release checksum mismatch' >&2; exit 1; }

command -v cosign >/dev/null 2>&1 || { printf '%s\n' 'trusted Cosign is required for release provenance verification' >&2; exit 1; }
fetch "$base_url/$asset.sigstore.json" "$temporary/$asset.sigstore.json" "$MAX_METADATA_BYTES"
cosign verify-blob-attestation --new-bundle-format=true --type slsaprovenance1 \
  --bundle "$temporary/$asset.sigstore.json" \
  --certificate-identity "https://github.com/provod-ai/cli-source/.github/workflows/native-release.yml@refs/tags/v${version}" \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$temporary/$asset" >/dev/null 2>&1 || { printf '%s\n' 'release provenance verification failed' >&2; exit 1; }

manifest="$temporary/archive-members"
tar -tzf "$temporary/$asset" > "$manifest" 2>/dev/null || { printf '%s\n' 'archive listing failed' >&2; exit 1; }
[ "$(wc -l < "$manifest" | tr -d ' ')" -eq 1 ] && [ "$(sed -n '1p' "$manifest")" = provod ] || {
  printf '%s\n' 'archive must contain exactly one provod executable' >&2
  exit 1
}
verbose="$temporary/archive-metadata"
tar -tvzf "$temporary/$asset" > "$verbose" 2>/dev/null || { printf '%s\n' 'archive metadata inspection failed' >&2; exit 1; }
[ "$(wc -l < "$verbose" | tr -d ' ')" -eq 1 ] && [ "$(cut -c1 "$verbose")" = '-' ] || {
  printf '%s\n' 'archive member must be a regular file' >&2
  exit 1
}
MAX_BINARY_BYTES=268435456
file_limit_blocks=$(((MAX_BINARY_BYTES + 511) / 512))
(
  ulimit -f "$file_limit_blocks"
  exec tar -xOzf "$temporary/$asset" provod > "$temporary/provod"
) 2>/dev/null || { rm -f "$temporary/provod"; printf '%s\n' 'archive extraction failed or exceeded its size limit' >&2; exit 1; }
bytes=$(wc -c < "$temporary/provod" | tr -d ' ')
if [ "$bytes" -gt "$MAX_BINARY_BYTES" ]; then
  rm -f "$temporary/provod"
  printf '%s\n' 'archive executable exceeds size limit' >&2
  exit 1
fi
[ -f "$temporary/provod" ] && [ ! -L "$temporary/provod" ] || { printf '%s\n' 'archive did not contain the expected executable' >&2; exit 1; }
mkdir -p "$destination"
[ -d "$destination" ] && [ ! -L "$destination" ] || { printf '%s\n' 'install directory must be a real directory' >&2; exit 1; }
directory_owner() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"; else stat -c '%u' "$1"; fi
}
directory_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}
directory_identity() {
  if stat -f '%d:%i' "$1" >/dev/null 2>&1; then stat -f '%d:%i' "$1"; else stat -c '%d:%i' "$1"; fi
}
held_destination_is_current() {
  [ "$(directory_identity .)" = "$verified_identity" ] || return 1
  [ -d "$display_destination" ] && [ ! -L "$display_destination" ] || return 1
  [ "$(directory_identity "$display_destination")" = "$verified_identity" ]
}
owner=$(directory_owner "$destination") || { printf '%s\n' 'could not inspect install directory owner' >&2; exit 1; }
[ "$owner" -eq "$(id -u)" ] || { printf '%s\n' 'install directory must be owned by the current user' >&2; exit 1; }
mode=$(directory_mode "$destination") || { printf '%s\n' 'could not inspect install directory permissions' >&2; exit 1; }
group_digit=$(((mode / 10) % 10))
other_digit=$((mode % 10))
[ $((group_digit & 2)) -eq 0 ] && [ $((other_digit & 2)) -eq 0 ] || {
  printf '%s\n' 'install directory must not be group- or world-writable' >&2
  exit 1
}
display_destination=$(CDPATH='' cd -P "$destination" && pwd -P) || { printf '%s\n' 'could not canonicalize install directory' >&2; exit 1; }
verified_identity=$(directory_identity "$display_destination") || { printf '%s\n' 'could not identify install directory' >&2; exit 1; }
[ "$(directory_identity "$display_destination")" = "$verified_identity" ] || { printf '%s\n' 'install directory identity changed before entry' >&2; exit 1; }
CDPATH='' cd -P "$display_destination" || { printf '%s\n' 'could not enter install directory' >&2; exit 1; }
in_destination=1
[ "$(directory_identity .)" = "$verified_identity" ] || { printf '%s\n' 'install directory identity changed during entry' >&2; exit 1; }

waited=0
lock_claim=$(mktemp .provod.install.claim.XXXXXX)
umask 077
printf '%s\n' "$lock_token" > "$lock_claim"
while ! ln "$lock_claim" .provod.install.lock 2>/dev/null; do
  [ "$waited" -lt 120 ] || { printf '%s\n' 'timed out waiting for another installation' >&2; exit 1; }
  sleep 1
  waited=$((waited + 1))
done
staged=$(mktemp .provod.install.XXXXXX)
cp "$temporary/provod" "$staged"
chmod 0755 "$staged"
if [ -e provod ] || [ -L provod ]; then
  [ -f provod ] && [ ! -L provod ] || { printf '%s\n' 'existing destination is not a regular file' >&2; exit 1; }
  had_existing=1
  backup=$(mktemp .provod.backup.XXXXXX)
  cp -p provod "$backup" || { printf '%s\n' 'could not preserve existing executable' >&2; exit 1; }
fi
held_destination_is_current || { printf '%s\n' 'install directory identity changed before replacement' >&2; exit 1; }
replacement_armed=1
mv -f "$staged" provod
reported=$(./provod --version 2>/dev/null) || { printf '%s\n' 'installed executable failed its version check' >&2; exit 1; }
[ "$reported" = "$version" ] || { printf '%s\n' 'installed executable reported an unexpected version' >&2; exit 1; }
held_destination_is_current || { printf '%s\n' 'install directory identity changed during version check' >&2; exit 1; }
committed=1
[ -z "$backup" ] || rm -f "$backup"
backup=''
printf 'installed Provod CLI %s at %s\n' "$version" "$display_destination/provod"

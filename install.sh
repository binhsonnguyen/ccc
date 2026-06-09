#!/usr/bin/env bash
# Install c3 from prebuilt release binaries — no Go, no Homebrew required.
# The macOS-recommended path is still `brew install binhsonnguyen/tap/c3`;
# this script is the channel for Linux and for anyone without Homebrew.
#
#   curl -fsSL https://raw.githubusercontent.com/binhsonnguyen/ccc/main/install.sh | bash
#
# Env overrides:
#   C3_VERSION=v0.2.39        pin a release (default: latest)
#   INSTALL_DIR=~/.local/bin  where the binaries go
#
# (Building from source instead: `git clone ... && make install`.)
set -euo pipefail

repo="binhsonnguyen/ccc"
install_dir="${INSTALL_DIR:-$HOME/.local/bin}"

err()  { echo "c3-install: $*" >&2; exit 1; }
info() { echo "› $*"; }

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v tar  >/dev/null 2>&1 || err "tar is required"

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) err "unsupported OS: $os (build from source: make install)" ;;
esac
case "$arch" in
  x86_64|amd64)  arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) err "unsupported arch: $arch" ;;
esac

# --- resolve version -------------------------------------------------------
tag="${C3_VERSION:-}"
if [ -z "$tag" ]; then
  info "resolving latest release..."
  tag="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$tag" ] || err "could not resolve the latest release tag"
fi
case "$tag" in v*) ;; *) tag="v$tag" ;; esac  # release path is v-prefixed
ver="${tag#v}"                                # archive filenames drop the v

asset="ccc_${ver}_${os}_${arch}.tar.gz"
base="https://github.com/$repo/releases/download/$tag"

# --- download + verify -----------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset ($tag)..."
curl -fSL "$base/$asset"        -o "$tmp/$asset"         || err "download failed: $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || err "could not fetch checksums.txt"

info "verifying checksum..."
want="$(awk -v f="$asset" '$2==f {print $1}' "$tmp/checksums.txt")"
[ -n "$want" ] || err "no checksum listed for $asset"
if command -v shasum >/dev/null 2>&1; then
  got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  err "need shasum or sha256sum to verify the download"
fi
[ "$got" = "$want" ] || err "checksum mismatch (got $got, want $want)"

# --- install ---------------------------------------------------------------
info "installing to $install_dir..."
tar -xzf "$tmp/$asset" -C "$tmp" c3-bin c3-server
mkdir -p "$install_dir"
install -m 0755 "$tmp/c3-bin"    "$install_dir/c3-bin"
install -m 0755 "$tmp/c3-server" "$install_dir/c3-server"
info "installed: $install_dir/{c3-bin,c3-server} ($tag)"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "! $install_dir is not on your PATH — add it to your shell rc" >&2 ;;
esac
command -v fzf >/dev/null 2>&1 \
  || echo "! fzf not found — the c3 picker needs it (brew install fzf / apt install fzf / ...)" >&2

cat <<'EOF'

Done. Enable the `c3` command in your shell rc:

  bash/zsh:  eval "$(c3-bin shell-init zsh)"
  fish:      c3-bin shell-init fish | source

Optional always-on GUI server:  c3 service start
Then open a new shell and run:   c3
EOF

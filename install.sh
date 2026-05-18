#!/usr/bin/env bash
# Install c3: builds c3-bin into ~/.local/bin and prints the line to add to
# your shell rc. Idempotent — safe to re-run.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${HOME}/.local/bin"
mkdir -p "$bin_dir"

# Version stamp: prefer `git describe`, fall back to "dev" for non-git
# trees. Override with VERSION=v0.1.0 ./install.sh if needed.
version="${VERSION:-$(cd "$repo" && git describe --tags --dirty --always 2>/dev/null || echo dev)}"

echo "› building c3-bin (version $version)"
(cd "$repo" && go build -ldflags "-X main.version=$version" -o "$bin_dir/c3-bin" ./cmd/c3-bin)
echo "› installed: $bin_dir/c3-bin"

# c3-server bakes in the installed default port (7755) via ldflag.
# Source builds (plain `go build`) keep "0" → random; see Makefile.
echo "› building c3-server (version $version, installed: port 7755)"
(cd "$repo" && go build -ldflags "-X main.defaultListenPort=7755 -X main.version=$version" -o "$bin_dir/c3-server" ./cmd/c3-server)
echo "› installed: $bin_dir/c3-server"

case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "! $bin_dir is not in PATH — add it to your shell rc" ;;
esac

if ! command -v fzf >/dev/null 2>&1; then
    echo "! fzf not installed — run: brew install fzf"
fi

shell_name="$(basename "${SHELL:-bash}")"
case "$shell_name" in
    fish)
        target="${HOME}/.config/fish/functions/c3.fish"
        mkdir -p "$(dirname "$target")"
        cp "$repo/shell/c3.fish" "$target"
        echo "› installed fish function: $target"
        ;;
    *)
        echo
        echo "Add this line to your ~/.${shell_name}rc:"
        echo "  source $repo/shell/c3.sh"
        ;;
esac

echo
echo "Done. Open a new shell (or source the line above) and try: c3"

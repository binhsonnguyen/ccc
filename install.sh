#!/usr/bin/env bash
# Install c3: builds c3-bin into ~/.local/bin and prints the line to add to
# your shell rc. Idempotent — safe to re-run.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${HOME}/.local/bin"
mkdir -p "$bin_dir"

echo "› building c3-bin"
(cd "$repo" && go build -o "$bin_dir/c3-bin" ./cmd/c3-bin)
echo "› installed: $bin_dir/c3-bin"

echo "› building c3-server"
(cd "$repo" && go build -o "$bin_dir/c3-server" ./cmd/c3-server)
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

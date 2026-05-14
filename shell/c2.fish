# c2 — shell wrapper for c2-bin (fish)
# Place at ~/.config/fish/functions/c2.fish

function c2
    if not command -q c2-bin
        echo "c2: c2-bin not found in PATH" >&2
        return 127
    end
    set -l cmd (command c2-bin $argv)
    set -l rc $status
    if test $rc -ne 0
        return $rc
    end
    if test -n "$cmd"
        eval $cmd
    end
end

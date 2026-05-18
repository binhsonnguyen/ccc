# c3 — shell wrapper for c3-bin (fish)
# Place at ~/.config/fish/functions/c3.fish

function c3
    if not command -q c3-bin
        echo "c3: c3-bin not found in PATH" >&2
        return 127
    end
    set -l cmd (command c3-bin $argv)
    set -l rc $status
    if test $rc -ne 0
        return $rc
    end
    if test -n "$cmd"
        eval $cmd
    end
end

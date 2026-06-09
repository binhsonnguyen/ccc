// shellinit.go — `c3-bin shell-init <shell>` prints the shell wrapper that
// defines the `c3` function. A child process can't cd/exec in its parent
// shell, so `c3` must be a shell function that eval's c3-bin's stdout. The
// binary is the single source of truth for that shim (zoxide/starship-style):
//
//	bash/zsh:  eval "$(c3-bin shell-init zsh)"     # in ~/.bashrc / ~/.zshrc
//	fish:      c3-bin shell-init fish | source     # in ~/.config/fish/config.fish
//
// The constants below are kept byte-identical to shell/c3.sh and
// shell/c3.fish (enforced by TestShellInitMatchesShippedFiles) so source
// installs that copy those files and brew installs that eval this output get
// exactly the same function.
package main

import "fmt"

// c3ShimPOSIX mirrors shell/c3.sh verbatim.
const c3ShimPOSIX = `# c3 — shell wrapper for c3-bin (works in bash and zsh)
#
# A child process cannot cd or exec in its parent shell, so c3-bin emits
# the command as a string and this wrapper eval's it in the user's shell.
# Source this file from ~/.bashrc or ~/.zshrc.

c3() {
  if ! command -v c3-bin >/dev/null 2>&1; then
    echo "c3: c3-bin not found in PATH" >&2
    return 127
  fi
  local cmd
  cmd="$(command c3-bin "$@")"
  local rc=$?
  if [ $rc -ne 0 ]; then
    return $rc
  fi
  if [ -n "$cmd" ]; then
    eval "$cmd"
  fi
}
`

// c3ShimFish mirrors shell/c3.fish verbatim.
const c3ShimFish = `# c3 — shell wrapper for c3-bin (fish)
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
`

// cmdShellInit prints the wrapper for the named shell to stdout.
func cmdShellInit(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("shell-init: missing shell (bash, zsh, or fish)")
	}
	switch args[0] {
	case "bash", "zsh", "sh":
		fmt.Print(c3ShimPOSIX)
	case "fish":
		fmt.Print(c3ShimFish)
	default:
		return fmt.Errorf("shell-init: unsupported shell %q (use bash, zsh, or fish)", args[0])
	}
	return nil
}

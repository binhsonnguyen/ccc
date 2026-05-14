# c2 — shell wrapper for c2-bin (works in bash and zsh)
#
# A child process cannot cd or exec in its parent shell, so c2-bin emits
# the command as a string and this wrapper eval's it in the user's shell.
# Source this file from ~/.bashrc or ~/.zshrc.

c2() {
  if ! command -v c2-bin >/dev/null 2>&1; then
    echo "c2: c2-bin not found in PATH" >&2
    return 127
  fi
  local cmd
  cmd="$(command c2-bin "$@")"
  local rc=$?
  if [ $rc -ne 0 ]; then
    return $rc
  fi
  if [ -n "$cmd" ]; then
    eval "$cmd"
  fi
}

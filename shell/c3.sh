# c3 — shell wrapper for c3-bin (works in bash and zsh)
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

# ccc

A personal tool for working with [Claude
Code](https://claude.com/claude-code) sessions. Two front-ends over
the same data:

- **CLI** — `c3` opens an fzf picker of every session you've ever
  had with Claude Code (filtered, archivable, scoped to PWD…) and
  resumes the one you pick. Same shell, same `claude`, just less
  finger-walking to find the right uuid.
- **GUI** — `c3 gui` opens a local web UI in your browser with a
  sidebar of sessions and a tab bar of live PTYs, each one running
  the real `claude` binary against the real session JSONL. Multi-tab,
  drag-reorder, command palette, the works.

Both front-ends are **thin**. c3 never owns your chat data — that
all stays in `~/.claude/projects/**`. You can stop using c3 and
`claude --resume <uuid>` keeps working unchanged.

## Install

**Homebrew (macOS):**

```sh
brew install --cask binhsonnguyen/tap/c3
```

(c3 ships as a Homebrew **cask**, which Homebrew only supports on macOS.
On Linux, install from source / the release tarball — see below.)

> **Upgrading from an older install?** c3 used to ship as a Homebrew
> *formula*. If a stale formula is still around, `brew install` can pick
> it up instead of the cask and leave you with a half-broken mix (the old
> `brew services` works but the new `c3` function / `c3 service` don't).
> Remove the old one first — see [Uninstall](#uninstall) — then install
> the cask with the `--cask` command above.

Then enable the `c3` command in your shell rc:

```sh
# bash/zsh (~/.bashrc, ~/.zshrc):
eval "$(c3-bin shell-init zsh)"

# fish (~/.config/fish/config.fish):
c3-bin shell-init fish | source
```

(`c3` has to be a shell function — it `cd`s and runs `claude` in *your*
shell — so `c3-bin` emits the wrapper for you to `eval`.)

**Install script (Linux, or macOS without Homebrew):**

Fetches the prebuilt binaries for your OS/arch from the latest release —
no Go, no Homebrew:

```sh
curl -fsSL https://raw.githubusercontent.com/binhsonnguyen/ccc/main/install.sh | bash
```

Pin a version with `C3_VERSION=vX.Y.Z` or change the target with
`INSTALL_DIR=…` (default `~/.local/bin`).

**From source:**

```sh
git clone https://github.com/binhsonnguyen/ccc && cd ccc && make install
```

Builds `c3-bin` + `c3-server` into `~/.local/bin` (needs Go 1.26+).

Every non-Homebrew install needs [`fzf`](https://github.com/junegunn/fzf)
(the picker) and, for the GUI, `claude` in `$PATH`; then enable the `c3`
command exactly as shown above (`eval "$(c3-bin shell-init zsh)"`).

**Optional — auto-start server:** to keep `c3-server` running in the
background (so `c3 gui` opens instantly without spawning anything), run

```sh
c3 service start        # status: c3 service status · stop: c3 service stop
```

This installs a LaunchAgent (macOS) or systemd `--user` unit (Linux)
with idle auto-shutdown disabled. It works the same whether you
installed via brew or from source.

**Installed vs source builds.** The installer bakes a **fixed port
7755** into c3-server (via `-ldflags`) so the GUI URL stays
bookmarkable. Source builds (`go build`, `go run ./cmd/c3-server`,
`go install …@latest`) default to a **random port** — better for dev
where multiple checkouts shouldn't fight over one address. Either
way, `C3_SERVER_PORT=NNNN` overrides; `=0` forces random. `c3 gui`
discovers the running server through `~/.local/share/c3/server.port`,
so the port number doesn't matter for the CLI flow.

## Uninstall

First stop the background server (if you started one) and drop the shell
wrapper line (`eval "$(c3-bin shell-init zsh)"`) from your `~/.zshrc` /
`~/.bashrc` / fish config:

```sh
c3 service stop         # tears down the LaunchAgent / systemd unit
```

Then remove the binaries by however you installed:

**Homebrew — new cask:**

```sh
brew uninstall --cask --zap binhsonnguyen/tap/c3
```

`--zap` also removes the LaunchAgent plist and c3's state dirs
(`~/.local/share/c3`, `~/.local/state/c3`).

**Homebrew — old formula** (only if you have the pre-cask install):

```sh
brew uninstall c3
```

**Install script / from source** (binaries live in `~/.local/bin`):

```sh
rm -f ~/.local/bin/c3-bin ~/.local/bin/c3-server
rm -rf ~/.local/share/c3 ~/.local/state/c3
rm -f ~/Library/LaunchAgents/com.c3.server.plist          # macOS
rm -f ~/.config/systemd/user/com.c3.server.service        # Linux
```

Your Claude sessions in `~/.claude/projects/**` are never touched —
`claude --resume <uuid>` keeps working after c3 is gone.

## CLI cheatsheet

```sh
c3                       # picker over your sessions, Enter to resume
c3 foo                   # picker pre-filtered by "foo"
c3 -1 foo                # auto-resume if exactly one match
c3 here                  # picker scoped to $PWD
c3 new [name]            # create a new session in a chosen cwd
c3 bind                  # adopt a Claude session you started elsewhere
c3 archive <id>          # toggle archive
c3 -a                    # picker over archived sessions
c3 rename <id> <name>
c3 rm <id>
c3 gui                   # open the web UI
```

Picker hotkeys: `Enter` resume, `Ctrl-N` new, `Ctrl-B` bind,
`Ctrl-A` archive/unarchive, `Ctrl-T` toggle active⇄archived view.

## GUI cheatsheet

`c3 gui` opens the local web UI; installed builds use
`http://127.0.0.1:7755`, source builds get a random port (see
[Install](#install)).

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette (fuzzy search sessions + actions) |
| `?` | Shortcuts cheatsheet (lists everything) |
| `/` | Focus sidebar filter |
| `⌘B` / `Ctrl+B` | Toggle sidebar |
| `← →` `Home` `End` | Switch tabs (when tab bar is focused) |
| `Delete` | Close focused tab |
| `r` / `a` / `Delete` | Rename / archive / remove focused row |
| `Esc` | Close overlay / drawer / menu |

Hover a sidebar row to peek the session's last few lines without
opening it. Sparkline next to each row shows bytes/sec from the
running PTY (live sessions only). Idle 4 s with the terminal focused
fades the chrome out of your way ("zen mode"); move the mouse to
restore.

**Paste images straight into the chat.** `Cmd-V` (or drag-drop) an
image onto a tab and c3 writes it to
`$TMPDIR/c3/<session-id>/images/`, then injects the absolute path
as a `@<path>` mention for claude to read. Plain-text paste still
falls through to xterm unchanged. The on-disk copy is ephemeral —
claude uploads the bytes at send-time and the OS reclaims `$TMPDIR`
on reboot, so no explicit cleanup is needed.

## Env vars

| Var | Default | Effect |
|---|---|---|
| `C3_SERVER_PORT` | `7755` (installed) / random (source) | listen port; `0` = random |
| `C3_SERVER_IDLE_MINUTES` | `15` | auto-shutdown after idle; `0` disables |
| `C3_NO_WRAPPER` | unset | CLI also echoes the eval'd command to stderr |
| `ccc:mention-regex` (localStorage) | `Error\|TODO\|FIXME` | regex matched against background-tab PTY output for the mention badge |

## Architecture (one paragraph)

`core/` holds entities + use-cases (Go, no I/O). `adapters/` are
the I/O: `claudefs` reads Claude's JSONL, `archivejson` reads/writes
c3's `archived.json` with `flock`, `ptyrunner` spawns `claude` (and
shell tabs) in a PTY — basing the child env on the resolved
login-shell environment so PATH/locale/tool vars match a normal
terminal even under launchd. `internal/ptymgr` keeps the live PTY map with scrollback,
activity counters, and discovery for pending uuids.
`cmd/c3-bin` is the CLI (calls core in-process; no daemon).
`cmd/c3-server` is the local HTTP+WS server for the GUI; `web/`
(React + Vite + xterm.js) builds into `internal/webdev/assets` and
is embedded into the c3-server binary via `go:embed`. For the
full picture see [`GUI-DESIGN.md`](GUI-DESIGN.md); for the per-PR
history see [`PLAN.md`](PLAN.md); for the CLI design rationale see
[`DESIGN.md`](DESIGN.md); for the UX critiques that drove the
polish work see [`UX-REVIEW-COMBINED.md`](UX-REVIEW-COMBINED.md).

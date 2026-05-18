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

```sh
./install.sh
```

That builds `c3-bin` and `c3-server` into `~/.local/bin` and (for
fish users) drops a function into `~/.config/fish/functions/`. For
bash/zsh, the installer prints the one line to add to your rc:

```sh
source /path/to/ccc/shell/c3.sh
```

Needs Go 1.26+, [`fzf`](https://github.com/junegunn/fzf), and (for
the GUI) `claude` itself in `$PATH`.

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

`c3 gui` opens `http://127.0.0.1:7755` (override with
`C3_SERVER_PORT=NNNN`, `=0` for random).

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

## Env vars

| Var | Default | Effect |
|---|---|---|
| `C3_SERVER_PORT` | `7755` | listen port; `0` = random |
| `C3_SERVER_IDLE_MINUTES` | `15` | auto-shutdown after idle; `0` disables |
| `C3_NO_WRAPPER` | unset | CLI also echoes the eval'd command to stderr |
| `ccc:mention-regex` (localStorage) | `Error\|TODO\|FIXME` | regex matched against background-tab PTY output for the mention badge |

## Architecture (one paragraph)

`core/` holds entities + use-cases (Go, no I/O). `adapters/` are
the I/O: `claudefs` reads Claude's JSONL, `archivejson` reads/writes
c3's `archived.json` with `flock`, `ptyrunner` spawns `claude` in a
PTY. `internal/ptymgr` keeps the live PTY map with scrollback,
activity counters, and discovery for pending uuids.
`cmd/c3-bin` is the CLI (calls core in-process; no daemon).
`cmd/c3-server` is the local HTTP+WS server for the GUI; `web/`
(React + Vite + xterm.js) builds into `internal/webdev/assets` and
is embedded into the c3-server binary via `go:embed`. For the
full picture see [`GUI-DESIGN.md`](GUI-DESIGN.md); for the per-PR
history see [`PLAN.md`](PLAN.md); for the CLI design rationale see
[`DESIGN.md`](DESIGN.md); for the UX critiques that drove the
polish work see [`UX-REVIEW-COMBINED.md`](UX-REVIEW-COMBINED.md).

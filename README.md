# cc-terminal

A personal tool for working with [Claude
Code](https://claude.com/claude-code) sessions. Two front-ends over
the same data:

- **CLI** — `c2` opens an fzf picker of every session you've ever
  had with Claude Code (filtered, archivable, scoped to PWD…) and
  resumes the one you pick. Same shell, same `claude`, just less
  finger-walking to find the right uuid.
- **GUI** — `c2 gui` opens a local web UI in your browser with a
  sidebar of sessions and a tab bar of live PTYs, each one running
  the real `claude` binary against the real session JSONL. Multi-tab,
  drag-reorder, command palette, the works.

Both front-ends are **thin**. cc never owns your chat data — that
all stays in `~/.claude/projects/**`. You can stop using cc and
`claude --resume <uuid>` keeps working unchanged.

## Install

```sh
./install.sh
```

That builds `c2-bin` and `c2-server` into `~/.local/bin` and (for
fish users) drops a function into `~/.config/fish/functions/`. For
bash/zsh, the installer prints the one line to add to your rc:

```sh
source /path/to/cc-terminal/shell/c2.sh
```

Needs Go 1.26+, [`fzf`](https://github.com/junegunn/fzf), and (for
the GUI) `claude` itself in `$PATH`.

## CLI cheatsheet

```sh
c2                       # picker over your sessions, Enter to resume
c2 foo                   # picker pre-filtered by "foo"
c2 -1 foo                # auto-resume if exactly one match
c2 here                  # picker scoped to $PWD
c2 new [name]            # create a new session in a chosen cwd
c2 bind                  # adopt a Claude session you started elsewhere
c2 archive <id>          # toggle archive
c2 -a                    # picker over archived sessions
c2 rename <id> <name>
c2 rm <id>
c2 gui                   # open the web UI
```

Picker hotkeys: `Enter` resume, `Ctrl-N` new, `Ctrl-B` bind,
`Ctrl-A` archive/unarchive, `Ctrl-T` toggle active⇄archived view.

## GUI cheatsheet

`c2 gui` opens `http://127.0.0.1:7755` (override with
`C2_SERVER_PORT=NNNN`, `=0` for random).

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
| `C2_SERVER_PORT` | `7755` | listen port; `0` = random |
| `C2_SERVER_IDLE_MINUTES` | `15` | auto-shutdown after idle; `0` disables |
| `C2_NO_WRAPPER` | unset | CLI also echoes the eval'd command to stderr |
| `cc-terminal:mention-regex` (localStorage) | `Error\|TODO\|FIXME` | regex matched against background-tab PTY output for the mention badge |

## Architecture (one paragraph)

`core/` holds entities + use-cases (Go, no I/O). `adapters/` are
the I/O: `claudefs` reads Claude's JSONL, `archivejson` reads/writes
cc's `archived.json` with `flock`, `ptyrunner` spawns `claude` in a
PTY. `internal/ptymgr` keeps the live PTY map with scrollback,
activity counters, and discovery for pending uuids.
`cmd/c2-bin` is the CLI (calls core in-process; no daemon).
`cmd/c2-server` is the local HTTP+WS server for the GUI; `web/`
(React + Vite + xterm.js) builds into `internal/webdev/assets` and
is embedded into the c2-server binary via `go:embed`. For the
full picture see [`GUI-DESIGN.md`](GUI-DESIGN.md); for the per-PR
history see [`PLAN.md`](PLAN.md); for the CLI design rationale see
[`DESIGN.md`](DESIGN.md); for the UX critiques that drove the
polish work see [`UX-REVIEW-COMBINED.md`](UX-REVIEW-COMBINED.md).

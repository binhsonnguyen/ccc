# c3 — Design (v4.1, MVP-focused)

A single CLI command `c3` that lets you resume any past Claude Code session
from any directory. No PTY hosting, no session abstraction layer, no tmux
dependency. Just: list → pick → `cd && exec claude --resume`.

> **Why v4.1 over v4:** counter-review caught a killer bug — decoding cwd from
> the project folder name (`-Users---Code-foo` → `/Users/_/Code/foo`) is
> ambiguous. Claude's encoding maps `_`, `/`, and literal `-` all to `-`, so
> `-Users---Code-AIGrow-ssai-backend` could be `/Users/_/Code/AIGrow-ssai-backend`
> *or* `/Users/_/Code/AIGrow/ssai/backend` — indistinguishable. Wrong cwd =
> resume in wrong git repo. v4.1 reads cwd from `projectPath` (sessions-index)
> or the `cwd` field inside the JSONL — both authoritative. Folder name is
> never decoded.
>
> **Why v4:** v1–v3 over-engineered. v1 (Rust TUI hosting PTY) was infeasible
> due to terminal limitations. v2 (shell + tmux + image paste) had unverified
> assumptions about Cmd+V/Alt+V. v3 added a parallel session model on top of
> Claude's already-existing one — bureaucratic overhead with broken auto-link
> via fsnotify (Claude doesn't write the JSONL until the first message,
> empirically verified).

---

## 1. What `c3` does

```
$ c3                       # picker (global, active sessions only)
$ c3 tap                   # picker pre-filtered by "tap" — never auto-resumes
$ c3 -1 tap                # auto-resume IF exactly one session matches
$ c3 here                  # picker, scoped to sessions in $PWD
                           #   (NOT `c3 -h` — `-h` is reserved for help)
$ c3 n                     # spawn fresh claude in $PWD (new session)
$ c3 -a                    # picker, archived sessions only
$ c3 archive <uuid|last>   # hide a session from default picker
$ c3 unarchive <uuid>      # bring it back
$ c3 --help
```

`c3 <query>` opens the picker pre-filtered. It does **not** auto-resume on
single-match — surprise execution is worse than one extra Enter. Use
`c3 -1 <query>` when you want auto-resume-if-unique.

That's the entire surface for v1.

### Picker hotkeys

| Key       | In default view (`c3`)         | In archived view (`c3 -a`)        |
| --------- | ------------------------------ | --------------------------------- |
| `Enter`   | resume highlighted session     | resume highlighted session        |
| `Ctrl-A`  | **archive** highlighted        | **unarchive** (restore) highlighted |
| `Ctrl-T`  | toggle view: active ⇄ archived | toggle view: archived ⇄ active    |
| `Esc`/`q` | quit                           | quit                              |

After archive/unarchive, the picker re-renders the (now updated) list in
place — user keeps browsing without losing context. Implemented via fzf
`--bind` with `reload(...)` actions calling back into `c3-bin --picker-action archive {1}`
where `{1}` is the uuid column. **`--picker-action` must (a) mutate
`archived.json` synchronously, then (b) emit the full updated session list
to stdout** — fzf's `reload` consumes that stdout to repopulate the list.

Archive scope: c3-only. Claude Code's own files are never modified;
`claude --resume <uuid>` of an archived session still works normally if
invoked directly. Archive purely controls c3's picker visibility.

### Picker UX

```
$ c3
┌─ c3 ──────────────────────────────────── 12 sessions ───┐
│ /  search…                                              │
│                                                         │
│ ▸ pulsar-mettronome  · main    · 2h ago                │
│   ↳ Add tap-tempo button to BPM controls                │
│                                                         │
│   ssai-backend       · feat/x  · yesterday              │
│   ↳ Chunked upload retry logic                          │
│   …                                                     │
│                                                         │
│ enter resume · n new · / search · q quit                │
└─────────────────────────────────────────────────────────┘
```

- Each row = one Claude session.
- Title = the `summary` Claude already assigns (from `sessions-index.json`).
  Fallback for folders without an index = first user prompt, truncated.
- Sort: most-recent `mtime` first.
- Filter: fzf fuzzy match across path + summary + branch.
- On `Enter`: `cd <cwd> && exec claude --resume <uuid>` in the current shell.

### Resumability after cancel

If the user Ctrl+C / `/quit` / closes the terminal mid-conversation, Claude
Code preserves the partial JSONL automatically. `c3` will surface it again
next time (it's the same UUID, same file, just a newer mtime). **No work
required from c3** — verified during M1 implementation.

---

## 2. Data sources

`~/.claude/projects/<encoded-cwd>/`:
- `sessions-index.json` — preferred, has `summary`, `gitBranch`, `modified`,
  `projectPath`. Present in ~30% of folders (newer Claude versions).
- `<uuid>.jsonl` — always present. Fallback path:
  - `mtime` → last active.
  - First `{"type":"user", ...}` line → fallback summary.
  - **Folder name is never decoded.** The encoding is lossy: `_`, `/`, and
    literal `-` all become `-`. Decoding is ambiguous and would silently
    `cd` to the wrong directory.

### cwd resolution (verified across 13 index files + sample JSONLs)

Resolved in priority order, with each fallback verified to exist on real
sessions:

1. **`entry.projectPath`** in `sessions-index.json` (per-entry). Present in
   most but not all entries.
2. **`originalPath`** at the *top level* of the same `sessions-index.json`
   (applies to every entry in that file). Present on every index file.
3. **JSONL `cwd` field** — but only on `type: "user"` and `type: "assistant"`
   lines. **Other line types** (`system`, `summary`, `attachment`,
   `queue-operation`, `last-prompt`, `ai-title`, etc.) do **not** carry `cwd`;
   the parser must filter to user/assistant types.
4. **Use the last `cwd` found, not the first.** Verified case:
   `codegym-storage-migrate` session has two cwds — the original repo and a
   `.../worktrees/crazy-ptolemy-adec5e` subdir. Worktree-style workflows
   `cd` mid-session; resuming at the last cwd is correct.

If all four fail, skip the session with a warning (don't guess).

Read-only. `c3` never writes to `~/.claude/`.

### Archive sidecar

The only state `c3` writes is a tiny JSON file:

```
~/.local/share/c3/archived.json
```

```json
{ "version": 1, "archived": ["b3680b2a-...", "df958176-..."] }
```

A flat list of UUIDs the user has chosen to hide. Default picker filters
these out; `c3 -a` shows only them; `c3 unarchive <uuid>` removes from
list. Atomic write via `.tmp` + rename. No locking needed (single-user,
short-lived writes, last-writer-wins is fine for a hide-list).

If the file is missing or corrupt, `c3` treats it as empty and continues.
No abstraction over Claude sessions — just a hide-list keyed by their
existing UUIDs.

### Resume command

```
cd <projectPath> && exec claude --resume <sessionId>
```

Exact behavior verified before shipping M1: the user's shell becomes Claude;
when Claude exits, the shell prompt resumes in the new directory.

---

## 3. Architecture

```
                 ┌─────────────────┐
   user types    │                 │      reads
   `c3`     ──▶  │   c3 binary     │ ───────────▶  ~/.claude/projects/
                 │   (Go, ~300 LoC)│                  *.json + *.jsonl
                 │                 │                  (read-only)
                 └────────┬────────┘
                          │ pipes rows to
                          ▼
                 ┌─────────────────┐
                 │   fzf (exec'd)  │
                 └────────┬────────┘
                          │ user picks
                          ▼
                 c3 prints `cd && exec claude --resume <uuid>`
                          │
                          ▼
                 shell wrapper evals it (see §5)
```

No daemon, no state file, no fsnotify, no tmux. The binary runs, picks,
prints a command, exits.

---

## 4. Sequence

### `c3` (default)

1. `os.UserHomeDir()` → walk `~/.claude/projects/*/`.
2. For each project folder: load `sessions-index.json` if present; else list
   `*.jsonl` and synthesize entries (parse first user line for summary).
3. Sort by `modified` (or `mtime`) descending.
4. Format rows: `<uuid>\t<display-text>` (uuid hidden, display visible).
5. Pipe to `fzf --with-nth=2.. --preview '<c3 internal preview cmd> {1}'`.
6. On selection: emit `cd <cwd> && exec claude --resume <uuid>` to stdout.
7. Shell wrapper `eval`s it (see §5).

### `c3 <query>`

Same as default, but pass `--query=<query>` to fzf (pre-filter). Picker still
opens; user confirms with Enter. **No `--select-1`** — surprise auto-exec is
bad UX.

### `c3 -1 <query>`

Use `fzf --filter=<query> --exit-0`. If exactly one match, emit the resume
command directly (skip picker). If zero matches, exit non-zero. If many,
fall back to opening picker pre-filtered.

### `c3 here`

Step 2 filters to sessions whose resolved cwd equals `$PWD` (or is a subdir
of it, configurable later). `-h` and `--help` are reserved for help output;
`c3-bin --help` prints to stderr and exits non-zero so the wrapper's
`eval "$cmd"` stays empty (no command to eval).

### `c3 n`

Skip everything. Emit `exec claude` (in current `$PWD`).

---

## 5. Shell wrapper

`c3` itself is a binary; the binary writes a command to stdout. To make
`c3` *change the user's directory and exec*, we ship a shell function:

```bash
# in ~/.zshrc / ~/.bashrc
c3() {
  local cmd
  cmd="$(command c3-bin "$@")" || return
  [ -n "$cmd" ] && eval "$cmd"
}
```

```fish
# in ~/.config/fish/functions/c3.fish
function c3
  set -l cmd (command c3-bin $argv); or return
  test -n "$cmd"; and eval $cmd
end
```

The actual binary is `c3-bin`; `c3` is the wrapper. `install.sh` adds the
function to the user's shell rc and warns if not present.

Why a wrapper: a child process cannot change its parent's `cwd` or `exec`
in the parent. We need shell help to do `cd` + `exec` in the user's shell.

### Quoting

Output is `cd <quoted-path> && exec claude --resume <uuid>`. The path is
shell-quoted using Go's equivalent of `printf %q` (single-quote-wrapped with
embedded single-quotes escaped as `'\''`). The uuid is fixed format (hex +
hyphens) so needs no quoting. Even though paths come from Claude's own JSON
(low injection risk), quoting is unconditional — defense in depth.

### Escape hatch

`C3_NO_WRAPPER=1 c3-bin ...` makes `c3-bin` print the command to stdout
without expecting an `eval` wrapper. For users on shells we don't ship
wrappers for, or those who prefer to run `eval "$(c3-bin)"` manually.

---

## 6. Project layout

```
c3/
├── DESIGN.md
├── README.md
├── go.mod
├── main.go                ← cobra-style commands, ~300 LoC total
├── internal/
│   ├── sessions/
│   │   ├── scan.go        ← walk projects/, parse index + jsonl fallback
│   │   ├── decode.go      ← `-Users---Code-foo` → `/Users/_/Code/foo`
│   │   └── format.go      ← row formatting, time-ago helper
│   └── picker/
│       └── fzf.go         ← exec fzf, parse selection
├── shell/
│   ├── c3.bash
│   ├── c3.zsh
│   └── c3.fish
└── install.sh             ← go build, copy bin, append shell snippet
```

---

## 7. Roadmap

### M1 — list + resume (1 day)
- Scan, parse, sort, fzf, emit command, shell wrapper.
- Verify: cancel mid-conversation → next `c3` shows it → resume works.

### M2 — `c3 here`, `c3 n`, `c3 <query>` (½ day)
- Flag handling, query filter, new-session shortcut.

### M3 — Archive (½ day)
- `archived.json` read/write, atomic.
- Default picker filters; `c3 -a` inverts; `c3 archive`/`unarchive` commands.
- Picker `Ctrl-A` binding (fzf `--bind`) to archive-in-place.

### M4 — Preview pane (½ day)
- `c3 --preview <uuid>` internal command tail-prints last few JSONL turns.
- Wire fzf `--preview`.

### M5 — Polish (½ day)
- Git branch + dirty marker (only if cheap; skip if it slows scan).
- `--json` machine-readable mode for scripting.
- Better empty-state and error messages.

**Total: ~5 days.** Honest estimate after counter-review (cwd-from-JSONL
parsing, fish wrapper, integration test for `claude --resume` round-trip,
fzf-not-installed handling each took half-days previously hidden in M1).

### Deferred
- tmux integration (open in new window when inside tmux). Add when user asks.
- Image paste from clipboard.
- Naming/tagging UUIDs (only if Claude's auto-summary proves insufficient).
- Concurrent-resume detection. Risk of JSONL corruption when same UUID
  resumed twice exists; document warning, defer guard until problem hits.

---

## 8. Risks

1. **`sessions-index.json` is undocumented internal state.** Tolerate
   missing/extra fields with `omitempty`. Always have JSONL fallback.
2. **`exec claude --resume <uuid>` semantics may change.** Pinned via
   integration test that runs in M1: spawn, send "hi", quit, resume,
   expect previous turn visible.
3. **Shell wrapper friction.** First-time install requires sourcing
   `c3.zsh`. `install.sh` does this and verifies; print a clear "add this
   line if your shell isn't supported" message.
4. **fzf must be installed.** Detect on first run, print one-line install
   hint (`brew install fzf`) and exit cleanly.

---

## 9. Explicitly NOT building (v1)

- A wrapper around the Claude UI.
- A separate c3-session model on top of Claude's UUIDs (archive list is
  keyed by Claude's existing UUIDs, not a parallel session model).
- fsnotify-based UUID auto-link (broken; Claude writes JSONL lazily).
- Multiplexer / tab manager (use tmux or wezterm if you want it).
- Image paste, naming, tagging, sync, daemon, GUI.
- Hard-delete of sessions (archive only hides; user can `rm` the JSONL
  themselves if they want it gone — outside c3's responsibility).

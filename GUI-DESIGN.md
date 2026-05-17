# cc — GUI Design (v5, draft)

Successor direction on top of v4.1. v4.1 (CLI resumer) stays; v5 adds a web
GUI as a **thin wrapper** around `claude --resume`, not a replacement.

## North star

> A GUI that connects to a Claude Code chat session, plus light utilities
> (list sessions, show working dir). **Thin** and **durable**: the user must
> always be able to `claude --resume <uuid>` directly without this app.

Concrete consequences of "thin":

- **No parallel data store.** Sessions, messages, history all live in
  Claude Code's own `~/.claude/projects/**/*.jsonl`. cc reads, never owns.
- **No reimplementation of the chat loop.** Anthropic SDK / Agent SDK are
  ruled out — they would replace `claude`'s tool-use, MCP, hooks, and
  create a fork of the data model.
- The GUI **hosts a PTY running the real `claude` binary** and pipes it
  to the browser via WebSocket. xterm.js renders. This is the same
  pattern as ttyd / gotty / code-server.
- Why v4.1's "PTY infeasible" doesn't apply: v1 was a *terminal*-hosted
  PTY (terminal-in-terminal → image paste, keybinding, resize hell). A
  browser xterm.js + WS PTY bridge is a well-trodden path with none of
  those blockers.

## Allowed server state

cc-server may keep transient, in-memory state *derived* from the PTY stream
(scrollback ring buffer, bytes/sec activity counter). These never persist to
disk, never become a source of truth, and disappear with the server. They are
read-only views that help the GUI; tearing the server down loses them and
that's fine — the data still lives in Claude's JSONL.

## UX model

Inspired by https://www.thecompanion.sh/ — sidebar of sessions, tab bar of
open PTYs, terminal pane on the right.

- **Sidebar**: list of sessions (uuid, cwd, title/first-message, last
  activity). Same data as the current fzf picker. Archive/unarchive
  controls.
- **Tab bar**: each tab = one live PTY attached to one session uuid.
- **Multiple PTYs in parallel.** Switching tab does **not** kill PTY.
  Closing tab = detach (PTY keeps running server-side so reopening the
  session re-attaches and shows scrollback). Explicit "kill" button to
  actually terminate.
- **PTY identity = session uuid.** Opening a session that already has a
  live PTY attaches to the existing PTY (tmux-style), does not spawn a
  second `claude --resume` on the same uuid.

## Architecture (clean / hexagonal)

```
core/                          -- pure Go, no I/O
  session.go                   -- Session entity
  ports.go                     -- SessionRepo, ArchiveStore, ClaudeRunner
  usecase/
    list_sessions.go
    archive_session.go
    resume_session.go          -- returns a runner handle; doesn't exec

adapters/
  claudefs/                    -- SessionRepo over ~/.claude/projects (moved from internal/sessions)
  archivejson/                 -- ArchiveStore over archived.json     (moved from internal/store)
  execrunner/                  -- ClaudeRunner that exec()s claude (for CLI)
  ptyrunner/                   -- ClaudeRunner that spawns claude in a PTY (for server)

server/                        -- thin HTTP/WS, depends only on core
  GET  /api/sessions
  POST /api/sessions/:id/archive
  POST /api/sessions/:id/unarchive
  WS   /api/sessions/:id/pty   -- bidirectional bytes + JSON control frames
                                  (resize, kill, ping)
  GET  /*                      -- static, serves the built web/ SPA

web/                           -- React + Vite + TypeScript + xterm.js
  sidebar, tab bar, terminal panes
  one WS per open tab

cmd/
  c2-bin/                      -- existing CLI; uses core + execrunner.
                                  Behavior unchanged: exec claude --resume.
  c2-server/                   -- runs server + serves web/.
                                  Entrypoint for `cc gui`.
```

CLI is **not** a thin client of the server. It calls core directly
in-process and `exec`s claude — preserves the v4.1 promise that the CLI
keeps working with zero daemon.

## Web stack

**React + Vite + TypeScript + xterm.js.** Chosen for ecosystem longevity
(the "dùng lâu được" criterion); Vite gives fast HMR; React's component
model fits multi-tab/sidebar state better than vanilla. Svelte/Solid are
faster at runtime but smaller ecosystems — not worth the tradeoff for a
personal tool meant to last. If the maintainer already has Svelte
fluency, SvelteKit is an acceptable swap; the server contract doesn't
change.

## Server lifecycle

- `cc gui` (new subcommand) spawns the server on `127.0.0.1:<port>` and
  opens the default browser.
- Server is **local-only**, no LAN/remote access (not a goal).
- Server **auto-shuts down** after N minutes of zero connected clients
  AND zero live PTYs — avoids a silent daemon hoarding RAM.
- Killing the server kills all PTYs. (PTYs are not designed to survive
  the server; durability comes from JSONL being written by `claude`
  itself, not from keeping processes alive across restarts.)

## Known limitations (from review, 2026-05-14)

These are accepted up front. Don't discover them after refactoring.

- **Image paste (Cmd+V) will break.** Claude Code relies on the native
  terminal emulator catching clipboard images and forwarding via OSC 1337
  (iTerm) or the Kitty image protocol. xterm.js does not support OSC 1337
  inline image *upload* from client. Either feature is dropped in GUI,
  or we add a custom clipboard→base64→stdin hack later. Out of scope for
  v5 MVP.
- **Drag-drop file** will likewise break — native terminals handle it,
  xterm.js needs custom JS handling. Defer.
- **Terminal capability queries** (`\e[c`, `\e[6n`) — xterm.js answers,
  but Claude may fall back to ASCII rendering in spots. Cosmetic, accept.
- **Auth re-login flow** (claude prints OAuth URL) — actually nicer in
  browser than native terminal; the URL is clickable.

## Concurrency + state, made explicit (from review)

- **Per-PTY scrollback ring buffer.** Server must hold ~1–4 MB of raw
  bytes per live PTY so a newly-attached client replays output and isn't
  blank until the next stdout. Cutting the buffer must respect ESC
  sequence boundaries (don't slice mid-CSI); easiest is to start replay
  from the most recent alt-screen clear.
- **Single-attach per PTY.** Opening a session that's already attached
  elsewhere **kicks the previous client** (sends a close frame, then the
  new client attaches). tmux-style multi-attach + shared stdin is
  rejected: with a single user it only produces confusion. UI must show
  a "this session is open in another tab/window — switching attach
  here" notice when this happens.
- **WS reconnect on tab refresh.** Treat as a fresh attach: server kills
  the old WS, replays scrollback to the new one. Sequence numbers not
  needed; whole-buffer replay is fine at this size.
- **archived.json race between CLI and server.** Both processes do
  read-modify-write. Atomic tmp+rename prevents partial files but not
  lost updates. Wrap RMW in `flock(2)` on a sidecar `archived.json.lock`.
  Implement in the `archivejson` adapter so both clients get it for free.
- **Server discovery.** Server writes `~/.local/share/cc/server.port`
  (and pid) on start, removes on shutdown. `cc gui` reads this first; if
  the port is alive, just open the browser tab instead of spawning a
  duplicate server. Lockfile-style.

## Architecture caveat (from review)

The clean/hexagonal layout described above is deliberately on the
formal side. For a ~1k LoC personal tool this is mild over-engineering
— acknowledged tax. The justification: there are genuinely 2
`ClaudeRunner` implementations (exec for CLI, pty for server) and 2
clients (CLI, web) over the same use cases, so ports do pay rent here.
But: don't add a port speculatively for a single implementation. If a
use-case is 10 lines, inline it at the caller rather than creating
`core/usecase/foo.go` for ceremony's sake.

## Phased plan

Each phase is independently verifiable; no phase blocks CLI usage.

**Phase 0 — Feasibility smoke test (do this before Phase 1).**
Before touching any Go code, spend ~2 hours validating the load-bearing
assumption: that `claude --resume` runs acceptably under a browser
xterm.js + WS PTY bridge. Concretely:

- Install `ttyd` (`brew install ttyd`).
- Run `ttyd -p 7681 -W claude --resume <some-uuid>` and open the URL.
- Use the session for 20–30 minutes: send messages, watch streaming
  output, test scrollback, tool use, MCP if applicable, resize the
  window, paste long text.
- Watch for: alt-screen flicker, color mismatch, dropped input, render
  lag on long streams, broken keybindings.

**Exit criteria**: TUI renders correctly, input is responsive, no
showstopper. Document any defects. If anything is a showstopper,
*revisit v5 itself* before Phase 1 — refactoring 4 phases on top of a
broken transport would be expensive.

1. **Refactor Go to clean-arch layout.** Move `internal/sessions` →
   `adapters/claudefs`, `internal/store` → `adapters/archivejson`,
   extract use-cases into `core/usecase`. Add `flock`-wrapped RMW in
   `archivejson`. CLI behavior identical.
2. **Server skeleton + minimal HTML.** `c2-server` binary, list endpoint,
   one HTML page (no framework) with xterm.js wired to WS PTY — proves
   `claude --resume` runs cleanly inside a browser terminal end-to-end
   in *our* server (not just ttyd). Includes scrollback ring buffer and
   server.port discovery file.
3. **React + Vite client.** Sidebar + tab bar + xterm panes against the
   verified server. WS-per-tab, single-attach kick semantics.
4. **PTY session manager.** Attach/detach polish, idle auto-shutdown,
   explicit kill, "open in another tab" notice UX.

## ID contract (between server and web client)

REST and WS endpoints under `/api/sessions/:id/...` all address by
the **c2-internal id** (8 hex chars). The pty manager keys live
sessions by **ClaudeUUID** internally; the server resolves c2 id →
ClaudeUUID inside `handleSessionPTY` before calling `manager.Attach`.

The web client carries both ids per tab:
- `claudeUuid` — dedup key for the in-memory term Map (one tab per
  Claude session even if multiple c2 entries point at it).
- `c2Id` — addressing key for the WS URL.

Don't conflate the two. Phase 3 launched with the client sending
claudeUuid in the URL by mistake; every WS open hit "entry not
found" and surfaced as an immediate "Disconnected" overlay. The
fix is in commit history; the lesson stays here.

## Open questions deferred

- Mobile/responsive layout — out of scope for v5.
- Auth — local-only, no auth (loopback binding is the boundary).
- Theming — defer; xterm.js defaults are fine for v5.
- Search across sessions — current sidebar filter (substring on
  title/cwd) is enough for v5; full-text JSONL search is later.
- Image paste / drag-drop — deferred per "Known limitations" above.
  Revisit only if Phase 0 reveals a clean workaround.
- Idle-PTY warning UX — if a PTY sits idle for hours, should the UI
  show a "session was idle, scrollback may be stale" hint on reattach?
  Defer until real usage tells us if it matters.

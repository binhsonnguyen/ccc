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

## Phased plan

Each phase is independently verifiable; no phase blocks CLI usage.

1. **Refactor Go to clean-arch layout.** Move `internal/sessions` →
   `adapters/claudefs`, `internal/store` → `adapters/archivejson`,
   extract use-cases into `core/usecase`. CLI behavior identical.
2. **Server skeleton + minimal HTML.** `c2-server` binary, list endpoint,
   one HTML page (no framework) with xterm.js wired to WS PTY — proves
   `claude --resume` runs cleanly inside a browser terminal.
3. **React + Vite client.** Sidebar + tab bar + xterm panes against the
   verified server.
4. **PTY session manager.** Attach/detach semantics, multi-tab survival
   across tab close, idle auto-shutdown, explicit kill.

## Open questions deferred

- Mobile/responsive layout — out of scope for v5.
- Auth — local-only, no auth (loopback binding is the boundary).
- Theming — defer; xterm.js defaults are fine for v5.
- Search across sessions — current sidebar filter (substring on
  title/cwd) is enough for v5; full-text JSONL search is later.

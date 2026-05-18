# c3 — GUI Design (v5)

v4.1 (CLI resumer, see `DESIGN.md`) stays as-is. v5 adds a web GUI as
a **thin wrapper** around `claude --resume`, not a replacement. This
doc captures the design rules that are load-bearing for future
changes; the per-PR scope and history live in `PLAN.md`.

## North star

> A GUI that connects to a Claude Code chat session, plus light
> utilities (list, archive, search, etc.). **Thin** and **durable**:
> the user must always be able to `claude --resume <uuid>` directly
> without this app.

Concrete consequences of "thin":

- **No parallel data store.** Sessions, messages, history all live in
  Claude Code's own `~/.claude/projects/**/*.jsonl`. c3 reads, never
  owns. The only c3-owned file is `archived.json` (visibility flags
  + names for c3 entries — not chat data).
- **No reimplementation of the chat loop.** Anthropic SDK / Agent SDK
  are ruled out — they would replace `claude`'s tool-use, MCP, hooks,
  and create a fork of the data model.
- The GUI **hosts a PTY running the real `claude` binary** and pipes
  it to the browser via WebSocket. xterm.js renders. Same pattern as
  ttyd / gotty / code-server.

## Allowed server state

c3-server may keep transient, in-memory state *derived* from the PTY
stream:

- Per-PTY scrollback ring buffer (~2 MB) — feeds reattach replay and
  the hover preview endpoint.
- Per-PTY bytes/sec activity ring (60 × 1 s) — feeds the sidebar
  sparkline.

These never persist to disk, never become a source of truth, and
disappear with the server. The chat data still lives in Claude's
JSONL; tearing the server down loses these views and that's fine.

## UX model

Inspired by https://www.thecompanion.sh/ — sidebar of sessions, tab
bar of open PTYs, terminal pane on the right.

- **Sidebar**: list sessions; row actions menu (rename / archive /
  remove / copy); segmented Active|Archived view; inline filter; "+
  New session" inline form (with Bind-existing mode); resizable
  width; collapses to a drawer under 800 px viewport.
- **Tab bar**: each tab is one live PTY attached to one session. Drag
  to reorder. Tabs survive switching; closing a tab detaches but
  leaves the PTY running so reopening reattaches and replays.
- **PTY identity = session uuid.** Opening a session that's already
  attached **kicks** the previous client (single-attach), then this
  client gets a scrollback replay.
- **Pending sessions** (entry exists but Claude hasn't created a
  JSONL for that cwd yet) open in a tab too — server spawns `claude`
  *without* `--resume` and watches for the first JSONL write, then
  PATCHes the entry with the discovered uuid. UI surfaces
  `{type:"pending"}` → `{type:"ready"}` so input is disabled until
  the upgrade lands.

## Architecture (clean / hexagonal, shipped state)

```
core/                            -- pure Go, no I/O
  session.go                     -- Session + ArchiveFile entities, methods,
                                    Find / List* / AddEntry / Add/RemoveArchived
  ports.go                       -- ArchiveStore + SessionsView (read-only
                                    window on the live PTY manager)
  usecase/
    archive.go                   -- ToggleArchive
    bind.go                      -- Bind (adopt an existing claude uuid)
    new_entry.go                 -- NewEntry (validate + AddEntry under lock)
    remove.go                    -- Remove (gates on live PTY unless forced)
    rename.go                    -- Rename
    errors.go                    -- sentinel ErrNotFound / ErrPTYLive / etc.

adapters/
  claudefs/                      -- reads ~/.claude/projects; Scan, ScanProject, Cwds
  archivejson/                   -- ArchiveStore over archived.json; Mutate wraps
                                    read-modify-write in syscall.Flock
  ptyrunner/                     -- spawns `claude [--resume <uuid>]` in a PTY

internal/
  picker/                        -- fzf wrapper for the CLI
  ptymgr/                        -- live PTY map keyed by session key (uuid when
                                    bound, c3 id while pending); scrollback ring,
                                    activity ring, single-attach kick,
                                    discovery loop for pending uuids
  webdev/                        -- go:embed of the built web/ bundle

cmd/
  c3-bin/                        -- CLI; calls core in-process and exec's claude.
                                    `c3 gui` spawns c3-server detached.
  c3-server/                     -- HTTP+WS on 127.0.0.1; serves embedded SPA.

web/                             -- React 18 + Vite + TypeScript + xterm.js
                                    + vanilla CSS. Built to internal/webdev/assets.
```

The CLI is **not** a thin client of the server. It uses core
in-process and exec's claude directly — preserves v4.1's no-daemon
guarantee. The server uses the same core + use-cases.

## HTTP surface (shipped)

All under `127.0.0.1:<port>`. Mutating routes carry a same-origin
CSRF check; the rest are GET-only.

| Route | Method | Purpose |
|---|---|---|
| `/api/sessions?archived&include=live` | GET | list active/archived; `live` flag from ptymgr.HasUUID |
| `/api/sessions` | POST | create a pending entry from `{cwd, name}` |
| `/api/sessions/:id` | GET | fetch one entry |
| `/api/sessions/:id` | PATCH | rename, body `{name}` |
| `/api/sessions/:id` | DELETE | remove; 409 if PTY live unless `?force=1` |
| `/api/sessions/:id/archive` | POST | toggle archived flag |
| `/api/sessions/:id/bind` | POST | adopt an existing claudeUuid, body `{claudeUuid}` |
| `/api/sessions/:id/pty` | WS | bidirectional bytes + JSON control |
| `/api/sessions/:id/tail?bytes=N` | GET | last N bytes of PTY ring buffer (text/plain). 204 if no live PTY |
| `/api/sessions/:id/activity` | GET | `{buckets: [60]uint32}` bytes/sec ring. 204 if no live PTY |
| `/api/claude-sessions` | GET | `{unbound, cwds}` for the Bind dialog + cwd picker |
| `/assets/*`, `/` | GET | static React bundle (embedded) |

**ID contract (load-bearing).** Every `/api/sessions/:id/...` route
addresses by the **c3-internal id** (8 hex chars). The pty manager
keys live sessions by their session key — claudeUuid when bound, c3
id while pending — and `handleSessionPTY` resolves the mapping
internally. The web client tracks both: `claudeUuid` (dedup key for
the in-memory xterm Map) and `c3Id` (URL addressing key). Don't
conflate them; PR 2 launched with the client sending claudeUuid in
the URL and every WS open 404'd — the fix is in commit history but
the lesson stays here.

**WS control frames.** Client → server: binary = stdin; text JSON
`{type:"resize",cols,rows}` or `{type:"kill"}`. Server → client:
binary = stdout; text JSON `{type:"pending"|"ready"|"kicked"|"exit"|"error"}`.

## Server lifecycle

- `c3 gui` (CLI subcommand) spawns c3-server detached and opens the
  browser. Re-running finds the live server via the discovery file
  and just opens the browser — no duplicate.
- **Default port 7755** (fixed for bookmark-ability). Override:
  `C3_SERVER_PORT=NNNN` or `=0` for a random OS-assigned port.
- Strict loopback bind. Same-origin Origin check on mutating REST
  and on WS `Accept`. No LAN access; not a goal.
- **Idle auto-shutdown** after `C3_SERVER_IDLE_MINUTES` (default 15)
  of zero live PTYs *and* zero attached clients. Set to 0 to
  disable. A generation counter in the manager closes the race
  between the watcher's decision and a fresh attach.
- Discovery file: `~/.local/share/c3/server.port` records port + pid
  on start and is removed on graceful shutdown (and on panic via a
  recover hook). Stale entries are detected via `kill -0` so a
  crashed previous run doesn't block startup.
- Killing the server kills all PTYs. Durability comes from `claude`
  writing its own JSONL, not from keeping PTYs alive across restarts.

## Concurrency rules (load-bearing)

- **Single-attach per PTY.** Opening a session that's already
  attached kicks the previous client (sends `{type:"kicked"}`, then
  close); the new client gets a scrollback replay.
- **Replay ordering.** Replay must be issued under the same lock the
  reader goroutine takes, so a fresh client never sees a new chunk
  before the snapshot.
- **WS reconnect on tab refresh = fresh attach.** Server replays the
  ring; no sequence numbers needed at this size.
- **archived.json RMW.** Both CLI and server can write. All
  mutations go through `archivejson.Store.Mutate`, which wraps the
  read-modify-write in `syscall.Flock` on a sidecar `.lock` file.
- **Discovery race for pending uuids.** Two pending sessions in the
  same cwd would both see the same new uuid pop into claudefs. The
  manager's `claimedUUIDs` map atomically claims a uuid before
  firing the bind hook so the second one drops it.

## Web client conventions

- **React 18 + Vite + TS + xterm.js + vanilla CSS.** No UI lib.
- **xterm instances live outside the React tree** (`lib/terminals.ts`
  Map keyed by claudeUuid) so switching tabs doesn't dispose them.
  All panes mount; inactive ones are hidden with CSS.
- **Shortcut registry** (`lib/shortcuts.ts`). Every key binding
  routes through `useShortcut({id, keys, scope, when, handler,
  label})`. Scopes: `global`, `tab-focused`, `sidebar-focused`,
  `menu-focused`. The cheatsheet (`?`) reads `listShortcuts()`.
- **CSRF for mutations.** All POST/PATCH/DELETE go through the
  server's same-origin guard; the browser's automatic Origin header
  is what carries it.
- **No localStorage of chat data.** Sidebar width, sidebar
  open/closed, optional mention regex, and tab order are stored
  client-side; nothing related to session content is.

## Known limitations

Accepted up front; don't rediscover after refactoring.

- **Image paste (Cmd+V) breaks.** xterm.js doesn't support OSC 1337 /
  Kitty inline image upload. Drop unless we ship a custom
  clipboard→base64 hack.
- **Drag-drop file** breaks for the same reason.
- **Terminal capability queries** (`\e[c`, `\e[6n`) — xterm.js
  answers, but Claude may fall back to ASCII rendering in spots.
  Cosmetic; accept.
- **Auth re-login flow** — Claude prints an OAuth URL; in the
  browser this is actually nicer (clickable) than in a native
  terminal.

## Open questions deferred

- Mobile / responsive beyond drawer mode.
- Multi-machine LAN access (not a goal).
- Theming presets (xterm defaults are fine for now).
- Full-text JSONL search (sidebar substring filter is enough).
- Image paste / drag-drop.
- Idle-PTY warning UX on reattach.
- URL-routed tabs so reload restores tabs (bigger than it looks).

History of how we got here lives in `PLAN.md` (per-PR scope) and
`UX-REVIEW*.md` (two independent reviews + combined).

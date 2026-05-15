# cc-terminal — Plan for B + C + D + power-tool layer

Bucket A (a11y + correctness) is shipped. This doc plans everything
that remains: feature parity with the v4.1 CLI (D), the production
shell pass (B), the distinctive UX layer (C), and the power-tool
layer (palette + shortcuts).

The order is **D → B → power-tool → C**. Why:
- D unblocks day-to-day GUI use (you can't archive from the GUI today,
  which forces the user back to the CLI mid-session).
- B makes the app feel real and gives D's new actions a home (status
  bar, motion, polished overlays).
- Power-tool is cheap to bolt on after shortcut infra exists.
- C is the "voice" layer; do it last when the rest is solid.

Each section has: **scope**, **server-side changes**, **client-side
changes**, **design notes**, **risk**, **rough effort**.

---

## D — Feature parity with the CLI (do first)

The CLI exposes archive, unarchive, rename, remove, new, bind. GUI
exposes none. Server only has archive. Both sides need work.

### D-1 — Server: missing REST endpoints

All addressed by c2 id (8 hex), consistent with the existing
`/api/sessions/:id/archive` and `/api/sessions/:id/pty` routes (see
`GUI-DESIGN.md` §ID contract). All under the same-origin CSRF guard.

- `GET  /api/sessions?archived=true&include=live` — list. `archived`
  flips active vs archived view; `include=live` adds a boolean `live`
  field per entry (`manager.has(uuid)`). Folding `live` into the list
  avoids the extra `pty-status` round-trip the earlier draft proposed.
- `PATCH /api/sessions/:id  { "name": "<new>" }` — rename. Server
  validates non-empty, ≤ 80 chars.
- `DELETE /api/sessions/:id` — remove. 409 if PTY live unless
  `?force=1`; on force, kick + kill before removing.
- `POST /api/sessions  { "cwd": "/abs/path", "name": "<opt>" }` — new
  c2-session entry. **Pending-UUID handling: option (b), see D-7.**
- `POST /api/sessions/:id/bind  { "claudeUuid": "<uuid>" }` — adopt
  an existing Claude session. Re-check inside `Mutate` that the uuid
  isn't already bound (lift the pattern from `cmdBind` in c2-bin).

All routes go through `usecase.*` so the CLI and server share the
mutation path. Where a use-case doesn't exist yet (rename, remove,
new, bind), add it under `core/usecase/` so the CLI can switch over
too.

flock contract unchanged: every write goes through
`archivejson.Store.Mutate`.

Tests required: rename empty/over-length, rename collision (same
name OK — we don't require unique names — but verify), remove
without force when PTY live → 409, remove with force kicks PTY,
bind on already-bound uuid (second caller loses), bind under
concurrent attach.

### D-2 — Server: claude-side listing + cwd suggestions

`GET /api/claude-sessions` returns:
- `unbound`: result of `claudefs.Scan` filtered to uuids not present
  in any c2 entry. Powers the Bind dialog in D-5.
- `cwds`: deduped recent cwds across both c2 entries and Claude's raw
  storage, ordered by recency. Powers the cwd picker in D-5.

One endpoint instead of two to keep the dialog's loading state
simple.

### D-3 — Client: row-level actions

Add a small actions menu on each sidebar row, surfaced via:
- A `⋯` icon button at the right of the row, visible on hover and
  always visible on keyboard focus.
- Right-click context menu (same items).
- Keyboard: while a session row has focus, `r` rename, `a` archive,
  `Delete` remove (with confirm), `Enter` open.

Menu items:
- Open in tab
- Rename… (opens an inline edit on the row name)
- Archive / Unarchive (toggle label based on current state)
- Remove… (two-step confirm; warns if PTY live)
- Copy uuid / Copy cwd

Invariants:
- **Only one menu open at a time.** Opening a second closes the first.
- ESC closes the menu and restores focus to the originating row.
- Menu uses the focus-trap pattern from Bucket A's overlay.

### D-4 — Client: view toggle Active ⇄ Archived

A small segmented control at the top of the sidebar, `[Active | Archived]`.
Calling `/api/sessions?archived=true` for the archived view. Archived
rows still show actions; Unarchive moves them back.

### D-5 — Client: "New session" + "Bind"

Below the segmented control, a `+ New session` button. Click opens a
small inline form:
- **Mode**: `[New | Bind existing]` tabs.
- **New**: text input for name (defaults to `basename(cwd)`), and a
  cwd picker. Cwd picker: a free-text input prefilled with current PWD
  if the server happens to know it, plus a dropdown of recent cwds
  derived from existing sessions and Claude's own session storage
  (mirrors `c2 new`'s candidate list).
- **Bind**: list from `/api/claude-sessions`; click one to adopt.

On submit, POST to the appropriate route, refresh the list, and
auto-open the new tab.

The new-session form is **not a modal** on desktop. It's an inline
expansion of the sidebar (between the segmented control and the
list).

In drawer mode (< 800 px viewport), the sidebar is only 280 px wide
and fights with the cwd dropdown. Fallback: open the form as a small
centered modal in that mode, using the Bucket A modal pattern (focus
trap + ESC + auto-focus first input).

### D-6 — Client: "Remove" guard rail

Remove is destructive (drops the entry; `c2 rm` already warns when
server is running and PTY is live). In the GUI:
- Two-step confirm in the menu (button turns red "Confirm?").
- The list already carries `live` (from `?include=live` in D-1), so
  the menu item reads "Remove… (PTY live — force)" when applicable
  and the DELETE call sends `?force=1`.

### D-7 — Pending-UUID handling for "New session"

This is the load-bearing design call for the whole bucket. Today
`handleSessionPTY` 409s on entries with empty `claudeUuid`, and
`ptyrunner.Start` always runs `claude --resume <uuid>`. A freshly
created entry has no uuid yet.

Three options were on the table; we pick **(b)** — accept the
complexity because the UX otherwise is broken.

(a) Server-side `lazyLink` on every list/attach. Cheap to implement
but doesn't help the very first attach: at that point Claude hasn't
written any JSONL for this cwd yet, so there's nothing to link.
Doesn't solve the dead-end on its own.

(b) **Chosen.** `ptyrunner.Start` accepts an empty uuid: if empty,
it runs `claude` (no `--resume`) in the cwd. The ptymgr keys this
session by **c2 id** for the duration the uuid is empty, then
upgrades to keying by ClaudeUUID once Claude writes its first JSONL
(`claudefs` watcher or a poll every 500 ms for ~20 s after spawn).
On upgrade, the server PATCHes the c2 entry with the discovered
uuid via `Mutate`. Existing list polling picks the new uuid up.

(c) Forbid "New" in the GUI until the user has used the CLI to
create a session. Defeats the point of the GUI for new users.

Implementation order inside D:
1. ptyrunner: accept empty uuid, spawn `claude` no-resume.
2. ptymgr: add a c2-id-keyed slot for "uuid-pending" sessions; key
   migration on uuid discovery.
3. claudefs: watcher / poller that returns "new uuids since T" in a
   given cwd.
4. server: discovery loop after Attach for pending sessions; PATCH
   entry on first match.
5. handleSessionPTY: when entry has empty uuid, dispatch to ptymgr
   in pending mode instead of 409.

This is **~1 day on its own**, which is why D's total estimate
revised below.

### Effort & risk

~3–4 days total (was 2; underestimate caught in review). Breakdown:
- D-1 + D-2 server endpoints + use-cases + tests: ~1 day.
- D-7 pending-uuid handling: ~1 day.
- D-3 + D-4 + D-5 + D-6 client UI: ~1–2 days.

Risks:
- D-7's uuid-upgrade race (user sends stdin before Claude finishes
  writing JSONL) needs handling — stdin must be buffered until
  upgrade or the spawn is fully transparent.
- Concurrent CLI + GUI: flock makes writes atomic, but the GUI
  polls list every 5 s, so it can show ≤ 5 s stale state after a
  CLI rename / archive. Acceptable; document in the README later.
- Rename / remove use-cases need tests (collision, validation,
  live-PTY refusal).

---

## B — Production shell (after D)

Items the two UX reviews both flagged, ordered by leverage.

### B-1 — Bottom status bar (~24 px)

```
┌──────────────────────────────────────────────────────────┐
│ ⏵ ~/Code/cc-terminal · connected · 96×32 · pid 4821 · ⌘K │
└──────────────────────────────────────────────────────────┘
```

Left: active tab's cwd (smart-truncated, click = copy). Center: WS
state + PTY dims. Right: pid + idle time + the palette shortcut hint
(stays even before we ship the palette so users discover it).

Implementation: a `<footer>` in `App.tsx` keyed off active tab. Data
already in scope — no new endpoints.

### B-2 — Sidebar filter input

Sticky input below the segmented control. Substring match (case-
insensitive) on name + cwd. Clears with `×`. `/` focuses it.

### B-3 — Resizable sidebar

4-px drag handle on the right border. Persist width to localStorage.
Bounds 200–480, double-click resets to 280. `⌘B` toggles open/closed
(same as the hamburger).

### B-4 — Tab overflow chevron + drag-reorder

When the tab strip overflows: replace the native h-scrollbar with a
right-edge fade mask + a chevron button that opens a dropdown listing
all tabs (with status dot). Drag-reorder tabs with HTML5 native dnd;
persist order to session storage.

### B-5 — Welcome rebuild

Center column, three quickstart cards: **Resume** (focus sidebar
search), **New session** (opens D-5 form), **Shortcuts** (opens the
shortcuts cheatsheet — see power-tool layer). Add a small ascii `cc`
mark in JetBrains Mono for branding without imagery.

### B-6 — Custom scrollbars

Thin (8 px) styled scrollbars for the sidebar and tab strip, matching
the dark theme.

### B-7 — Motion pass

- 80 ms ease-out on session/tab hover bg.
- 120 ms fade on tab open/close (`max-width` + opacity).
- 150 ms `opacity` + `translateY(-4px) → 0` on overlays.
- Skeleton rows in the sidebar on first load (3 shimmer rows).
- Status-dot color crossfade rather than hard swap.

### B-8 — Typography scale + tabular nums

Define `--text-xs/sm/base/lg/xl` = 11/12/13/15/18, swap call sites.
Enable `font-feature-settings: 'tnum'` for the status bar columns
(cols×rows, pid, idle).

### Effort

~2–3 days total. Each item is small and independent — can be cherry-
picked or batched.

---

## Power-tool layer (after B)

### P-1 — Command palette (`⌘K` / `Ctrl+K`)

Centered overlay (use the modal pattern from Bucket A — focus trap,
ESC closes). Fuzzy search across:
- Sessions (open in tab)
- Actions (Refresh, Close all tabs, Kill active, Toggle sidebar,
  Switch to tab N, New session, Bind…, Archive / Unarchive active)

Grouped results, keyboard-first. No external dep — ~150 lines of
React + a fuzzy matcher (tiny, hand-roll or `fzf.js` if needed).

### P-2 — Shortcuts cheatsheet (`?` or `⌘/`)

2-column grid, searchable, grouped (Navigation / Tabs / Sessions /
Misc). Driven by a single shortcuts registry so adding a binding
auto-updates the cheatsheet.

### P-3 — Shortcut registry + global key dispatcher

Replace ad-hoc `keydown` handlers across components with a tiny
central registry. Each entry: `{ id, keys, label, scope, handler }`.
Scope decides where the handler fires (`global`, `tab-focused`,
`sidebar-focused`).

### Effort

~1.5 days, with P-3 done first.

---

## C — Distinctive layer (the voice pass)

Pick 2–3 of these. They're independent.

### C-1 — Activity sparkline per session row

24 × 6 canvas drawn from a per-session ring of "bytes/sec over last
60 s". Server already streams stdout; add a tiny rolling counter in
ptymgr and a `GET /api/sessions/:id/activity` (or piggyback on a
heartbeat WS). Risk: cost — cap to live PTYs only, ≤ 1 update/sec.

**Thin-wrapper note:** this introduces transient *derived* state in
`ptymgr` (bytes/sec counter) that doesn't exist in any Claude file.
Acceptable under the rule because (a) it's purely in-memory, never
written to disk, never owned by cc; (b) it disappears with the
server. We update `GUI-DESIGN.md` to bless transient derived state
in ptymgr the same way the scrollback ring is blessed today, before
shipping this. If that update is rejected, drop C-1.

### C-2 — Last-frame preview on sidebar hover

600 ms hover delay → a 40 × 6 char tooltip showing the last 6 lines
from the session's PTY scrollback. Pull on hover (cached 5 s) via a
new `GET /api/sessions/:id/tail` returning the tail of the ring
buffer. Doesn't keep state client-side — minimal lock-in.

### C-3 — Workspace tinting per cwd

`hash(cwd) → hue`. Active tab's accent uses that hue. Sidebar row
gets a 2-px left strip in the same hue. Pair with a monogram (first
letter of basename) for colorblind users.

### C-4 — Zen-mode auto-fade

When xterm has focus and the pointer is idle 4 s, fade sidebar and
tabbar to opacity 0.4. Pointer move → 1.0. Skip when an overlay is
open.

### C-5 — Mention badge

User-configured regex per session (or global). Match against PTY
output; show a small numeric badge on inactive tabs whose match count
incremented. Clears on tab focus.

Config stored client-side only (localStorage) for v1 — doesn't sync
across machines, and is never persisted server-side. Settings panel
deferred.

### Effort

~1 day each, independent.

---

## Cross-cutting decisions

### Sharing logic between CLI and server

Today the CLI calls `usecase.ToggleArchive` directly and the server
also calls it. Continue that pattern. Every new mutation (rename,
remove, new, bind) lands in `core/usecase/` first, then both `cmd/c2-
bin/main.go` and `cmd/c2-server/main.go` route through it. flock
inside `archivejson.Store.Mutate` keeps everyone honest.

### Don't model "session state" beyond what claude already gives us

Pin / mention / activity all live in the GUI client (localStorage or
in-memory) or in transient server-side derived state (ring buffers).
None of it touches `archived.json`. The thin-wrapper rule stays.

### URL routing

Switching to URL-routed tabs (so reload restores tabs) is a bigger
change than it looks: it needs hashed paths or History API + a small
router. Defer to a later cycle; not in this plan.

### Toolchain

Stay on React 18 + Vite + vanilla CSS + xterm.js. No new runtime
deps unless P-1's fuzzy matcher really needs one.

---

## Implementation order (concrete)

P-3 was moved to land before B because every B item that binds a key
(`/` for search, `⌘B` for sidebar toggle, etc.) wants the registry —
sequencing the registry first prevents scattered ad-hoc handlers we
would have to refactor anyway.

1. **D-1, D-2, D-7** — server endpoints + use-cases + tests +
   pending-uuid handling. One PR.
2. **D-3, D-4, D-5, D-6** — client UI for the new endpoints. One PR.
3. **P-3** — shortcut registry + global key dispatcher (no new
   shortcuts shipped yet). One small PR to unblock B.
4. **B-1, B-5, B-6, B-8** — status bar, welcome rebuild, scrollbars,
   typography. One PR ("production shell, visible parts").
5. **B-2, B-3, B-4, B-7** — search, resizable sidebar, tab overflow,
   motion. All using the P-3 registry. One PR ("behavior parts").
6. **P-1, P-2** — palette + cheatsheet on top of P-3. One PR.
7. **C-3** (cwd tinting) — small, immediate visual win. One PR.
8. **C-1** (sparkline) or **C-2** (preview) — pick one based on
   appetite. Update `GUI-DESIGN.md` before C-1.
9. **C-4** (zen fade), **C-5** (mention badge) — optional.

After each PR: counter-review (visual + a11y + perf if relevant). The
flow that worked in Phases 1–4 stays.

### Items intentionally not in this plan

- `c2 -1 <query>` auto-resume CLI equivalent — Sidebar filter (B-2)
  + Enter on the only match is good enough. No bespoke shortcut.
- Session group / folder in the sidebar — UX-REVIEW C suggested it;
  deferred to a later cycle. Quick filter + groups by cwd basename
  inside the existing list is the smaller next step if we ever pick
  this up.
- URL-routed tabs (reload restores tabs) — bigger than it looks;
  separate cycle.

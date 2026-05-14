# cc-terminal — UX/UI Review (2026-05-14)

A senior frontend designer review of the v5 web GUI. Reads `web/src/**`
only — couldn't screenshot the running app, so all numbers/colors come
from the actual CSS tokens, not guesses.

This is a roadmap, not a punch list. We are unlikely to do all of it.
Use it to pick a few high-impact bets per cycle.

---

## Part 1 — Critique by axis

### Typography — no scale
- Six discrete sizes (10/11/12/13/14/18) with no ratio. Welcome `h1`
  is 18px, anchor-less.
- Define a scale `--text-2xs/xs/sm/base/lg/xl` = 11/12/13/15/18/22.
- Enable `font-feature-settings: 'tnum'` for uuid / dims / pid columns.
- `letter-spacing: 0.08em` on the uppercase header (`styles.css:75`) is
  too loose at 11px; 0.06em reads better.

### Spacing — no grid
- Six different padding combos that don't share a step. Adopt 4-px
  rhythm: `--space-1..6 = 4/8/12/16/20/24`. Session row padding-y from
  8 → 10 to hit ~56 px row height (Fitts).
- Active tab uses `border-top: 2px` + `padding-top: 4px` to compensate
  layout shift. Cleaner: `box-shadow: inset 0 2px 0 var(--accent)`.

### Color / contrast
- `--text-faint #7a8290` on `--sidebar-bg #252526` ≈ 4.4:1. Works for
  body but not for the 10-px session-uuid line — either hide on hover
  or bump to 11 px.
- `--border #2a2a2d` is 1.1:1 against `--sidebar-bg`. Invisible.
  Replace with `rgba(255,255,255,0.07)` (and add `--border-strong`
  ~0.14 for prominent dividers).
- Status colors lazy: `connecting` is amber (warning color) — switch
  to a dim-accent pulse so amber stays for actual warnings.

### Information hierarchy
- Session rows show 3 lines (name / cwd / uuid8). The uuid line is
  technical noise; move it to `title` / hover-reveal.
- cwd ellipsis truncates the tail — the project name is the part you
  most want to see. Smart-truncate: `.../parent/project`.
- Welcome is centered text with no CTA, no shortcut hints, no
  branding. First impression is wasted.

### Affordance / interaction
- Refresh and close glyphs are Unicode (`↻`, `×`, `⏻`); render
  inconsistent across OSes. Switch to inline SVG (Lucide).
- `window.confirm` for kill (TabBar.tsx) is the worst craft hit in
  the app — native modal breaks the dark theme. Render an in-app
  confirm card; we already have `overlay-card` for it.
- Kill `⏻` and close `×` glyphs sit side by side and read as the
  same group. Either hide kill behind hover / right-click, or use a
  different metaphor (Stop ⏹ + tooltip).
- No right-click menus anywhere. Lost room for Copy uuid / Copy cwd
  / Reveal in Finder / Duplicate tab / Pin.

### Motion / feedback
- Two animations total (`pulse`, toast slide). Add 80–150 ms easings
  for: session hover bg, tab switch, overlay fade-in, status dot
  state change.
- No skeleton while sidebar list first loads. Add 3–5 shimmer rows.
- All five statuses (connecting/connected/disconnected/kicked/
  exited/error) should be visually distinct. They currently share
  too few hues.

### Density
- Sidebar at 280 px fixed. No virtualization. With 100+ sessions the
  list becomes unusable mainly because there's no search/filter —
  not because of repaint cost.
- Tab strip uses native horizontal scrollbar for overflow. Replace
  with a chevron overflow menu + custom thin scrollbar.

### State communication
- `kicked` doesn't name who kicked us. Surface the new attach's
  hint if the server knows.
- `disconnected` makes the user click Reconnect. Add an optional
  countdown auto-retry with a cancel.
- `exited` shows the code but no next action.
- Toast has one slot; events overwrite. Queue + variants
  (info/warn/error/success) + action button + hover-pause.

### Edge cases
- 100+ sessions: needs search + grouping.
- Long cwd: tail-ellipsis hides basename.
- Narrow window (<700 px): sidebar fixed 280, no breakpoint. Collapse
  to drawer toggle.
- Light mode: hard-coded `color-scheme: dark`. Add a toggle.

---

## Part 2 — Specific improvements, ranked

| #  | Item                              | Impact | Effort  |
|----|-----------------------------------|--------|---------|
| 1  | Command palette (Cmd+K)           | HIGH   | ~1 day  |
| 2  | Sidebar search/filter input       | HIGH   | ~2 h    |
| 3  | Resizable sidebar (persist width) | HIGH   | ~2 h    |
| 4  | Tab overflow menu + drag-reorder  | HIGH   | ~3 h    |
| 5  | Status bar (bottom 22 px)         | HIGH   | ~2 h    |
| 6  | Keyboard shortcuts (no native modals) | HIGH | ~3 h    |
| 7  | Custom scrollbars                 | MEDIUM | ~30 min |
| 8  | Smart cwd truncation              | MEDIUM | ~1 h    |
| 9  | Polish overlay cards (blur, fade) | MEDIUM | ~1 h    |
| 10 | Skeleton + better empty/welcome   | MEDIUM | ~1 h    |
| 11 | Toast queue + variants            | MEDIUM | ~1 h    |
| 12 | Tab visual refinement             | MEDIUM | ~1 h    |
| 13 | Typography scale + tabular nums   | MEDIUM | ~1 h    |
| 14 | Right-click context menus         | MEDIUM | ~3 h    |
| 15 | Border/divider system rebuild     | LOW    | ~30 min |

Details for each are in the full review (saved alongside this file in
the cc-terminal/UX-REVIEW-FULL.md if we ever paste the raw report).

---

## Part 3 — Feature roadmap (UI/UX scope)

Each item is tagged with its fit against the "thin wrapper" rule.

1. **Command palette (Cmd+K)** — fuzzy-search sessions + actions.
   Pure UI. Fit: ✅.
2. **Pinned tabs + persistent tab restore** — survive page reload by
   restoring open uuids from localStorage. Fit: ✅ (still just
   reattach `claude --resume`).
3. **Split panes (horizontal/vertical)** — view two sessions side by
   side. Fit: ✅.
4. **Background-task notifications** — flash status / Web Notification
   when a backgrounded tab's PTY transitions from busy → idle. Fit:
   ⚠️ (heuristic could couple us to claude's prompt format; keep it
   purely PTY-output-based).
5. **Sidebar grouping & quick filter** — chips (All / Open / Recent),
   collapsible folders by cwd parent. Fit: ✅.
6. **Theme + font customization** — 3 presets + custom; xterm font
   options + UI chrome font separate. Fit: ✅.
7. **Transcript find / export** — `@xterm/addon-search`; export
   scrollback to .txt/.html (ANSI preserved). Fit: ✅.
8. **Session metadata rail (Cmd+I)** — surface what we already know
   from `C2Entry` + connection info. Don't scrape claude output.
   Fit: ⚠️ if we get tempted to parse claude state.
9. **Shortcuts cheatsheet (Cmd+/ or `?`)** — 2-col grid, searchable.
   Maintain a single shortcuts registry. Fit: ✅.
10. **Connection health popover** — click status dot for WS state,
    last ping, bytes I/O, last error. Fit: ✅ (transport-only).

---

## Recommended investment order

Pick from these three buckets, not all at once.

- **Power-tool bucket (biggest leverage)**: #1 palette, #2 search,
  #6 shortcuts, F1 palette, F9 cheatsheet. These together make the
  app feel like a serious dev tool instead of a hobby UI.
- **Production-shell bucket**: #5 status bar, #9 overlay polish, #11
  toast queue, F10 connection diagnostics. App stops feeling
  empty/MVP.
- **Craft pass**: #7, #8, #12, #13, #15 — small typography / spacing
  / divider work, finishes the surface.

Roadmap features F1–F4 are core. F5–F10 are layer 2. F4 (background
notifications) and F8 (metadata rail) are the only ones with a thin-
wrapper risk; everyone else is pure UI.

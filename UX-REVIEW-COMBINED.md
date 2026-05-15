# cc-terminal — UX Review combined (R1 + R2)

Two independent senior-designer reviews. R1 (`UX-REVIEW.md`) was
code-only — strong on design tokens and information architecture. R2
was visual-first (Chrome DevTools MCP, 10 screenshots, computed-style
measurements) — caught accessibility-target violations and live-state
bugs R1 missed. This doc is the merge: where they agree, where they
disagree, and what to do.

---

## Where both reviews independently agree (high confidence)

These are real because two reviewers reached them from different paths.

1. **`window.confirm` for the Kill action is the worst craft hit in
   the app.** Native modal breaks dark theme, blocks the UI, can't be
   styled. Replace with either an inline two-step confirm on the
   button (click 1 turns it red "Confirm kill?", revert after 3 s) or
   reuse the existing `.overlay-card` pattern.
2. **The UUID line on every sidebar row is mostly noise.** Hide by
   default, surface in `title` / on hover. Free vertical space for
   higher-signal info (last active, model, badge).
3. **Welcome screen is a wasted first impression.** Centered prose,
   no anchor, no shortcuts, no logo, no CTA. Both reviewers flag this
   without prompting.
4. **No status bar / no persistent app shell.** Bottom of the
   workspace is empty; the UI floats. Adding a 22-px status bar with
   cwd / WS state / pid is a high-leverage move both reviewers
   suggested.
5. **Tab strip handles overflow with the native horizontal scrollbar.**
   Needs a custom thin scrollbar at minimum; ideally an overflow
   chevron menu or a fade-mask hint at the right edge.
6. **Motion is essentially absent.** Only `pulse` and toast slide
   exist. Hovers, tab switches, overlay appearances all hard-cut.
7. **Typography has no scale.** Six discrete sizes (10/11/12/13/14/18)
   with no ratio. Tokenize to a real scale and switch monospaced
   number columns to `font-feature-settings: 'tnum'`.
8. **Responsive: sidebar is fixed 280 px with no breakpoint.** Narrow
   windows squeeze the terminal to unusable; mobile is hopeless. Need
   a collapse / drawer behavior under ~800 px.
9. **Toast is single-slot, no queue, no dismiss, no variants.** R2
   actually caught this happening live ("Failed to load sessions"
   stuck for 10 minutes).
10. **Status colors aren't distinct enough across the five states**
    (connecting / connected / disconnected / kicked / exited / error).
    Two reviewers independently flagged amber-for-connecting as a
    semantic mismatch (amber is warning).

---

## Where R2 alone caught it (visual-only finds)

R1 read code and missed live behavior and pixel measurements.

### CRITICAL (a11y / actual breakage)

- **Tab `×` and `⏻` buttons measure ~17.7 × 16 px — under WCAG 2.5.5
  target-size minimum (24 × 24).** R1 didn't compute pixels. Fix:
  `min-width: 24px; min-height: 24px; display: inline-flex; padding:
  4px 6px;` and a gap between the two buttons so Fitts doesn't bite.
- **The "modal" overlay doesn't trap focus, doesn't cover sidebar/
  tabbar, doesn't ESC-close.** Backdrop is absolute inside the pane
  only. Either commit to full-modal semantics (focus trap + full-
  viewport backdrop + ESC) or downgrade to an **inline banner** above
  the terminal. R2 strongly recommends inline banner — fits the
  thin-wrapper, non-intrusive philosophy better than a half-modal.
- **TabBar has `role="tab"` children but no parent `role="tablist"`.**
  No arrow-key navigation, no roving tabindex. Current Tab order
  steps through every button inside every tab → 15 stops for 5 tabs.
  Fix: wrap in `tablist`, `tabIndex={isActive ? 0 : -1}`, bind Left/
  Right/Home/End/Delete.
- **Pending session item is a `<button disabled>` that still receives
  focus** with no visual cue of why. Either render as non-focusable
  `<div>` with tooltip, or add an `aria-disabled` visual state.

### HIGH (live-behavior bugs)

- **Toast persists indefinitely.** Auto-dismiss 5–8 s for non-errors;
  for errors, give it a `×` and an action button (Retry).
- **Focus ring uses `outline-offset: -2px`** which eats into text on
  the tab. Switch to a halo pattern (`box-shadow: 0 0 0 2px var(--bg),
  0 0 0 4px var(--accent)`) so the ring lives outside.
- **Sidebar dot (6 px) and tab status dot (8 px) both use the accent
  blue but mean different things** ("session is open in a tab" vs
  "WS is connected"). Differentiate texture: tab dot ring/hollow,
  sidebar dot solid.
- **Reconnect URL behavior under narrow viewport** — overlay
  max-width 380 overflows a 320-px pane into the sidebar edge.

R1 hadn't run the app live so missed all of the above.

---

## Where R1 alone caught it (architecture/IA finds)

R2 was visual; R1 was structural.

- **No spacing grid.** Six padding combos that don't share a step.
  Adopt 4-px rhythm tokens `--space-1..6`.
- **`--border #2a2a2d` against `--sidebar-bg #252526` is 1.1:1** —
  effectively invisible. R2 mentioned the divider is "gần như tan
  vào nền" but didn't compute. Same finding, R1 had the numerical
  proof.
- **Tab `border-top: 2px` + `padding-top: 4px` to compensate layout
  shift** is fragile. Use `box-shadow: inset 0 2px 0 var(--accent)`
  to anchor the active marker without changing geometry.
- **Tab overflow needs a chevron menu, not just scrolling.** R2
  suggested a fade-mask; R1 suggested a chevron + drag-reorder. Both
  are good; do both.
- **Resizable sidebar + persisted width** (R1 #3). R2 didn't
  flag this directly but the responsive critique covers the same
  pain.

---

## Feature ideas

R1's 10 features overlap with the usual suspects: command palette,
pinned tabs, splits, sidebar groups, themes, transcript export,
metadata rail, shortcuts cheatsheet, connection health, background
notifications.

R2 brought eight unusual ideas worth pulling forward — they're not
generic and they fit the thin-wrapper rule:

1. **Ghost cursor**: 1-px progress bar under a sidebar session when
   its background PTY emits output. Fades 2 s after last write.
2. **Last-frame preview on sidebar hover**: 600 ms hover →
   mini-terminal tooltip showing last 6 × 40 chars of the PTY's
   scrollback. Saves a tab switch to check "is claude done?".
3. **Inline reconnect banner instead of overlay** (28-px warn strip
   below tabbar; doesn't steal focus, terminal stays usable).
4. **Workspace tinting per cwd**: hash(cwd) → hue; active tab's
   border-top uses that hue instead of fixed accent. Distinguish tabs
   by color, not just text. Pair with a monogram for colorblindness.
5. **Activity sparkline**: 24 × 6 px sparkline per sidebar row
   showing PTY bytes/sec over the last 60 s. Instantly shows which
   sessions are alive vs idle.
6. **Drag-to-split pane** (Phase 3 of any roadmap).
7. **Mention badge**: user-configured regex over PTY output triggers
   a numeric badge on a background tab.
8. **Zen-mode auto-fade**: when xterm has focus and pointer is idle
   4 s, sidebar/tabbar fade to opacity 0.4. Move mouse → 1.0.

Best three to pick first: **inline reconnect banner**, **activity
sparkline**, **last-frame preview**. They make the app feel alive
without adding feature creep.

---

## Combined verdict

R1 said "late-alpha / early-beta with empty production-shell". R2
said the same in different words. Both reach the same three buckets:

### Bucket A — a11y + correctness debts (do this first)
Items where the app is technically broken or unfriendly:

1. Tab target size → 24 × 24 (R2 CRITICAL).
2. `role="tablist"` + arrow-key navigation (R2 CRITICAL).
3. Replace `window.confirm` with in-app confirm (both).
4. Overlay → inline reconnect banner (R2 architectural call).
5. Toast auto-dismiss + variants + retry action (both).
6. Disabled session items: don't focus them, or show why (R2).
7. Focus ring halo not inset (R2).
8. Sidebar collapse / drawer under ~800 px (both).

**Effort total: ~1.5 days. Impact: app stops failing audits.**

### Bucket B — production shell (do this next)
Items that move the app from "MVP function" to "feels real":

1. Bottom status bar (cwd + ws state + pid + ⌘K hint) (both).
2. Better Welcome (shortcuts cheatsheet, branding, CTA) (both).
3. Sidebar filter input (`/` to focus) (R1).
4. Resizable sidebar with persistence (R1).
5. Custom scrollbars (R1).
6. Tab overflow chevron + drag-reorder (R1) + fade-mask (R2).
7. Motion pass (hover/switch/overlay/skeleton) (both).

**Effort total: ~2–3 days. Impact: feels like a polished tool.**

### Bucket C — distinctive layer (do this when bored)
Items that give the app a voice — pick 2–3 from R2's list:

1. Activity sparkline in sidebar.
2. Last-frame preview on hover.
3. Workspace tinting per cwd + monogram.
4. Zen-mode auto-fade.
5. Mention badge.

**Effort total: ~3–4 days. Impact: distinguishes from "another xterm
wrapper".**

### Optional — power-tool layer
Command palette (Cmd+K), shortcut cheatsheet (Cmd+/), pinned tabs +
restore. R1 ranked these highest; R2 said they're baseline. Reality:
they're table stakes for any dev tool but not differentiating.
Schedule after Bucket A is done — they're cheap to bolt on once
shortcuts infra exists.

---

## Recommendation

**Start with Bucket A.** The a11y debts are the only items both
reviewers independently flagged as breaking, and they're cheap
(~1.5 days total). After that, **alternate**: one Bucket B item per
session, one Bucket C item per session. That keeps the polish work
from feeling like a slog and ships visible "new" things alongside.

Don't do Bucket A and "feature work" in the same PR. The bucket A
work touches semantics globally (focus, roles, keys); easier to
review in isolation.

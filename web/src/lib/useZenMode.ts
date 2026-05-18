import { useEffect, useState } from 'react';

// C-4 Zen-mode auto-fade.
//
// When the xterm element is focused (i.e. the user is typing into a
// Claude session) and the pointer has been idle for `idleMs`, fade the
// surrounding chrome (sidebar + tabbar). Any pointer movement, or the
// terminal losing focus, restores it immediately.
//
// Overlay-open detection uses a single DOM query rather than threading
// state through props. The selector list mirrors the overlay surfaces
// that exist today: modal overlays (.overlay covers terminal-dead,
// new-session modal, palette, cheatsheet — the latter two add
// .palette-overlay), the row context menu (.row-menu), and the session
// preview tooltip (.session-preview). If a new overlay class ships,
// add it here.
const OVERLAY_SELECTOR =
  '.overlay, .palette-overlay, .row-menu, .session-preview';

// We honor prefers-reduced-motion by short-circuiting: the hook stays
// mounted but never sets faded=true, and the listeners no-op. This is
// cheaper than tearing the hook down and avoids re-evaluating on every
// render.

export function useZenMode(idleMs = 4000): boolean {
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mql?.matches) return;

    let timer: number | null = null;
    // Throttle mousemove processing to ~1 Hz. xterm canvas redraws on
    // mousemove inside the terminal, so we cannot afford to call
    // setState on every event.
    let lastMove = 0;

    const xtermFocused = (): boolean => {
      const el = document.activeElement as HTMLElement | null;
      return !!el?.closest('.xterm');
    };
    const overlayOpen = (): boolean =>
      document.querySelector(OVERLAY_SELECTOR) !== null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const arm = () => {
      clearTimer();
      if (!xtermFocused() || overlayOpen()) return;
      timer = window.setTimeout(() => {
        // Re-check at fire time: focus or overlay state may have
        // changed during the idle period.
        if (xtermFocused() && !overlayOpen()) setFaded(true);
        timer = null;
      }, idleMs);
    };

    const wakeUp = () => {
      setFaded((cur) => (cur ? false : cur));
      arm();
    };

    const onMove = () => {
      const now = performance.now();
      if (now - lastMove < 1000) {
        // Still within throttle window: keep the timer ticking, and
        // make sure faded clears via functional setState (cheap no-op
        // when already false — React skips the re-render).
        setFaded((cur) => (cur ? false : cur));
        return;
      }
      lastMove = now;
      wakeUp();
    };

    const onFocusChange = () => {
      if (!xtermFocused()) {
        setFaded(false);
        clearTimer();
      } else {
        arm();
      }
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('focusin', onFocusChange);
    window.addEventListener('focusout', onFocusChange);

    // Initial arm in case xterm is already focused on mount.
    arm();

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('focusin', onFocusChange);
      window.removeEventListener('focusout', onFocusChange);
      clearTimer();
    };
  }, [idleMs]);

  return faded;
}

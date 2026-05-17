import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  // Cwd shown verbatim in the tooltip header — Sidebar already passes
  // the full path, so we just collapse $HOME to ~ for readability.
  cwd: string;
  name: string;
  // Loaded text (already ANSI-stripped) or null while in-flight.
  text: string | null;
  // Anchor rect of the source row — drives fixed positioning. We read
  // it once on mount; if the row scrolls under the user during the
  // 200 ms dismiss grace the preview can drift a few px, which is
  // strictly less surprising than re-pinning while the user is
  // moving the cursor.
  anchorRect: DOMRect;
  // Mouse handlers wired from the Sidebar so the dismiss timer pauses
  // while the cursor is over the preview itself.
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const WIDTH = 360;
const VIEWPORT_PAD = 8;
const HOME_PREFIX = '~';

// Best-effort home shortening — purely cosmetic, the data already
// contains the full path. We only collapse the very prefix because
// matching mid-path home is not meaningful.
function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  // The web client has no access to the OS env so we rely on a
  // convention: if the path starts with /Users/<name>/ or /home/<name>/,
  // collapse the first two segments.
  const m = cwd.match(/^\/(Users|home|root)\/[^/]+(\/|$)/);
  if (m) {
    const rest = cwd.slice(m[0].length);
    return rest ? `${HOME_PREFIX}/${rest}` : HOME_PREFIX;
  }
  return cwd;
}

// stripAnsi removes the common terminal escape sequences so a preview
// renders as readable text. Naïve by design — we accept occasional
// junk on DCS / OSC edge cases since the tooltip is decorative.
export function stripAnsi(s: string): string {
  return s
    // CSI: ESC [ params final-byte
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] ... BEL (or ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS / PM / APC / SOS: ESC P|X|^|_ ... ST
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Other single-char escapes (charset selection, etc.)
    .replace(/\x1b[()*+./][\s\S]/g, '')
    .replace(/\x1b[=>]/g, '')
    // Stray BEL / leftover ESCs
    .replace(/[\x07\x1b]/g, '');
}

// lastLines returns up to `n` non-empty trailing lines from `s`.
// Trailing blank lines (cursor sitting on a fresh prompt) are skipped
// so the preview shows actual output rather than a column of blanks.
export function lastLines(s: string, n: number): string[] {
  if (!s) return [];
  // Collapse CR-only and CRLF; keep LF as the splitter.
  const norm = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const all = norm.split('\n');
  // Trim trailing empties.
  let end = all.length;
  while (end > 0 && all[end - 1].trim() === '') end--;
  return all.slice(Math.max(0, end - n), end);
}

export default function SessionPreview({
  cwd,
  name,
  text,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Compute position after layout so we know our own height.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth || WIDTH;
    let left = anchorRect.right + VIEWPORT_PAD;
    // Flip to the left of the row if we'd clip the right edge.
    if (left + w > window.innerWidth - VIEWPORT_PAD) {
      left = Math.max(VIEWPORT_PAD, anchorRect.left - w - VIEWPORT_PAD);
    }
    let top = anchorRect.top;
    if (top + h > window.innerHeight - VIEWPORT_PAD) {
      top = Math.max(VIEWPORT_PAD, window.innerHeight - h - VIEWPORT_PAD);
    }
    setPos({ left, top });
  }, [anchorRect, text]);

  // ESC dismisses — handled at Sidebar level too, but we add a local
  // listener so it works even when nothing else owns focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMouseLeave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onMouseLeave]);

  const lines = text == null ? null : lastLines(stripAnsi(text), 6);
  const cwdShort = shortenCwd(cwd);

  return (
    <div
      ref={ref}
      className="session-preview"
      role="tooltip"
      aria-hidden="true"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="session-preview-header">
        <span className="session-preview-name">{name}</span>
        {cwdShort && <span className="session-preview-cwd">{cwdShort}</span>}
      </div>
      <div className="session-preview-body">
        {lines === null ? (
          <div className="session-preview-empty">loading…</div>
        ) : lines.length === 0 ? (
          <div className="session-preview-empty">—</div>
        ) : (
          <pre>{lines.join('\n')}</pre>
        )}
      </div>
    </div>
  );
}

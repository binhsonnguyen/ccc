// C-5 Mention badge — regex source-of-truth.
//
// The pattern is read once at module load from localStorage. Power
// users can edit it via DevTools:
//
//   localStorage['cc-terminal:mention-regex'] = '\\bclaude:\\s'
//
// then reload. We do not surface UI for this yet — by design, this
// feature is a "you know you want it" power-tool, not a default
// surface. Invalid patterns silently fall back to DEFAULT (no toast,
// no console error — the badge is decorative; failing loud would be
// noisier than the feature is worth).
const LS_KEY = 'cc-terminal:mention-regex';
const DEFAULT = 'Error|TODO|FIXME';

function compile(source: string): RegExp {
  // 'g' so .match() returns all occurrences. 'i' for forgiving
  // matching (the default pattern's keywords are case-mixed in the
  // wild). Power users who want case-sensitive can wrap in a
  // lookahead — fine, we don't try to be clever.
  return new RegExp(source, 'gi');
}

function loadRegex(): RegExp {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw && raw.length > 0) return compile(raw);
  } catch {
    /* localStorage may be disabled (Safari private mode) */
  }
  try {
    return compile(DEFAULT);
  } catch {
    // Should never happen — DEFAULT is a literal — but TypeScript
    // doesn't know that, and a thrown error here would crash App.
    return /Error|TODO|FIXME/gi;
  }
}

let cached: RegExp = loadRegex();

export function mentionRegex(): RegExp {
  return cached;
}

// countMatches: number of regex matches in `s`. We rebuild the search
// from .lastIndex=0 each call so callers can share the cached regex.
export function countMatches(s: string): number {
  if (!s) return 0;
  const re = cached;
  re.lastIndex = 0;
  const m = s.match(re);
  return m ? m.length : 0;
}

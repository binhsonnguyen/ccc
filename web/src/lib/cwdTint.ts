// C-3: derive a stable hue from a cwd string so each working directory gets
// a consistent visual tint across tabs + sidebar rows. Same cwd → same hue,
// always (no random/seeded state). Cheap djb2-like hash keeps this O(n) on
// the path length and dependency-free.
//
// We intentionally do not import a heavy color lib — hsl() with literal
// numbers is enough for the dark UI and keeps bundle delta tiny.

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // (h * 33) ^ char — classic djb2 xor variant. Unsigned-coerce at the
    // end so the hue mod is stable across negative-int territory.
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

// Hash the basename separately from the parent then mix with a bit
// rotation. djb2 alone clusters siblings ("~/Code/web" vs
// "~/Code/api") into nearby hues; this breaks them apart so a
// monorepo doesn't show three reds in a row.
function mixedHash(cwd: string): number {
  const trimmed = cwd.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const parent = idx >= 0 ? trimmed.slice(0, idx) : '';
  const a = djb2(base);
  const b = djb2(parent);
  // Rotate a by 13 bits before xor so base + parent stir more widely.
  const rot = ((a << 13) | (a >>> 19)) >>> 0;
  return (rot ^ b) >>> 0;
}

export function cwdHue(cwd: string): number {
  if (!cwd) return -1; // sentinel for "no cwd" — render as neutral gray.
  return mixedHash(cwd) % 360;
}

// Bright-on-dark accent (border-left, border-top, active monogram bg).
// 65% sat / 62% light reads well over #1e1e1e and #252526 without
// clipping to neon on common hues. The -1 sentinel returns a neutral
// gray so a pending/empty cwd doesn't get a red "error" vibe.
// Note: lightness is read from --tint-l (defined per-theme in
// styles.css). Dark theme keeps 62 %; light theme drops to ~45 % so
// the hue still passes AA on a near-white background.
export function cwdTint(cwd: string): string {
  const h = cwdHue(cwd);
  if (h < 0) return 'hsl(0 0% 45%)';
  return `hsl(${h} 65% var(--tint-l, 62%))`;
}

// Brighter variant used as foreground on top of the dim wash so the
// monogram letter stays readable on blue/purple hues that fail AA
// against a near-dark bg in their normal 62% lightness.
export function cwdTintFg(cwd: string): string {
  const h = cwdHue(cwd);
  if (h < 0) return 'hsl(0 0% 75%)';
  return `hsl(${h} 60% var(--tint-fg-l, 78%))`;
}

// Subtle muted variant for tiny backgrounds (e.g. monogram chip in
// resting state). Low sat + low light → barely-there wash that still
// hints at hue.
export function cwdTintDim(cwd: string): string {
  const h = cwdHue(cwd);
  if (h < 0) return 'hsl(0 0% 18%)';
  return `hsl(${h} 30% var(--tint-dim-l, 22%))`;
}

// First letter of the basename, uppercased. Serves as a colorblind-safe
// secondary signal next to the hue.  Falls back to '?' for empty cwd.
// We split on '/' rather than pulling in a path lib — the server normalizes
// paths and trailing slashes aren't expected, but we handle them anyway.
export function cwdMonogram(cwd: string): string {
  if (!cwd) return '?';
  const trimmed = cwd.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const ch = base.charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

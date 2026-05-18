// Theming presets. Three curated themes — dark (default), light,
// solarized-dark — applied to BOTH the app chrome (CSS variables on
// <html>) AND every live xterm.js instance.
//
// Persistence: localStorage key `c3:theme`. Read on App mount via
// applyTheme(); xterm construction reads the active xterm theme via
// getCurrentTheme() so newly-opened tabs match the chrome.
//
// To switch live terminals, call applyTheme(name) — it walks the
// `terms` Map from terminals.ts and assigns `term.options.theme`.
// xterm.js picks up the change on the next frame.

import type { ITheme } from '@xterm/xterm';
import { allUuids, getTerm } from './terminals';

export type ThemeName = 'dark' | 'light' | 'solarized-dark';

export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'solarized-dark'] as const;

const LS_KEY = 'c3:theme';

interface ThemeDef {
  // Class to set on document.documentElement. null = default (dark),
  // since dark vars live in :root.
  chromeClass: string | null;
  // xterm.js ITheme — background, foreground, cursor, plus full 16-color
  // ANSI palette (regular + bright). xterm falls back to terminal
  // defaults for any missing field, but we set them explicitly so the
  // three themes stay visually distinct.
  term: ITheme;
}

// Dark = current default (matches the inline theme used by terminals.ts
// before this file existed). 16-color ANSI palette is xterm.js stock.
const DARK: ThemeDef = {
  chromeClass: null,
  term: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#3a3d41',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
  },
};

// Light theme: low-eye-strain, not pure white. ANSI: muted variants
// tuned for contrast on #fafafa (all foreground colors hit ≥ 4.5:1).
const LIGHT: ThemeDef = {
  chromeClass: 'theme-light',
  term: {
    background: '#fafafa',
    foreground: '#1e1e1e',
    cursor: '#1e1e1e',
    cursorAccent: '#fafafa',
    selectionBackground: '#c8d9ef',
    black: '#1e1e1e',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#a21caf',
    cyan: '#0e7490',
    white: '#5a5a5a',
    brightBlack: '#4b5563',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#c026d3',
    brightCyan: '#0891b2',
    brightWhite: '#1e1e1e',
  },
};

// Solarized Dark — canonical Ethan Schoonover values.
//   base03=#002b36  base02=#073642  base01=#586e75  base00=#657b83
//   base0=#839496   base1=#93a1a1   base2=#eee8d5   base3=#fdf6e3
const SOLARIZED_DARK: ThemeDef = {
  chromeClass: 'theme-solarized-dark',
  term: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
};

export const THEMES: Record<ThemeName, ThemeDef> = {
  dark: DARK,
  light: LIGHT,
  'solarized-dark': SOLARIZED_DARK,
};

let current: ThemeName = 'dark';

function readStoredTheme(): ThemeName {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'dark' || v === 'light' || v === 'solarized-dark') return v;
  } catch {
    /* ignore */
  }
  return 'dark';
}

export function getCurrentTheme(): ThemeName {
  return current;
}

export function getCurrentXtermTheme(): ITheme {
  return THEMES[current].term;
}

// Apply a theme: update chrome class on <html>, persist to localStorage,
// and walk every live xterm instance to swap its theme. xterm.js's
// options setter triggers an internal redraw, so no manual refresh()
// needed in practice — we keep the call site defensive anyway.
export function applyTheme(name: ThemeName) {
  current = name;
  // Chrome class — remove every theme class then set the active one (if
  // not null). Using a fixed list keeps this idempotent even when class
  // attribute is touched by other code.
  const html = document.documentElement;
  for (const n of THEME_NAMES) {
    const cls = THEMES[n].chromeClass;
    if (cls) html.classList.remove(cls);
  }
  const cls = THEMES[name].chromeClass;
  if (cls) html.classList.add(cls);

  // Persist.
  try {
    localStorage.setItem(LS_KEY, name);
  } catch {
    /* ignore */
  }

  // Update every live xterm instance.
  const next = THEMES[name].term;
  for (const uuid of allUuids()) {
    const entry = getTerm(uuid);
    if (!entry) continue;
    try {
      entry.term.options.theme = next;
    } catch {
      /* ignore */
    }
  }
}

// Read+apply the stored theme. Call once on app mount, ideally in a
// layout effect so the class is set before first paint. We also call
// it eagerly at module-load via initThemeEarly() below.
export function initTheme(): ThemeName {
  const name = readStoredTheme();
  applyTheme(name);
  return name;
}

// Eager init: runs at module import time so the chrome class is on
// <html> before React mounts. Safe because applyTheme only touches the
// DOM and (empty at this point) terminals Map.
export function initThemeEarly() {
  if (typeof document === 'undefined') return;
  const name = readStoredTheme();
  current = name;
  const html = document.documentElement;
  for (const n of THEME_NAMES) {
    const cls = THEMES[n].chromeClass;
    if (cls) html.classList.remove(cls);
  }
  const cls = THEMES[name].chromeClass;
  if (cls) html.classList.add(cls);
}

// Theming presets — six curated themes applied to BOTH the app chrome
// (CSS variables on <html>) AND every live xterm.js instance.
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

export type ThemeName = 'dark' | 'light' | 'solarized-dark' | 'hc-dark' | 'hc-light' | 'solarized-light';

export const THEME_NAMES: readonly ThemeName[] = [
  'dark', 'light', 'hc-dark', 'hc-light', 'solarized-dark', 'solarized-light',
] as const;

const LS_KEY = 'c3:theme';

interface ThemeDef {
  chromeClass: string | null;
  term: ITheme;
}

const DARK: ThemeDef = {
  chromeClass: null,
  term: {
    background:          '#1a1a1a',
    foreground:          '#d4d4d4',
    cursor:              '#c8c8c8',
    cursorAccent:        '#1a1a1a',
    selectionBackground: '#3a3d41',
    selectionForeground: '#d4d4d4',
    black:         '#3a3a3a',
    red:           '#cd3131',
    green:         '#0dbc79',
    yellow:        '#c9ae00',
    blue:          '#2472c8',
    magenta:       '#bc3fbc',
    cyan:          '#11a8cd',
    white:         '#c5c5c5',
    brightBlack:   '#666666',
    brightRed:     '#f14c4c',
    brightGreen:   '#23d18b',
    brightYellow:  '#f0e000',
    brightBlue:    '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan:    '#29b8db',
    brightWhite:   '#ffffff',
  },
};

const LIGHT: ThemeDef = {
  chromeClass: 'theme-light',
  term: {
    background:          '#f8f8f8',
    foreground:          '#1a1a1a',
    cursor:              '#1a1a1a',
    cursorAccent:        '#f8f8f8',
    selectionBackground: '#b8d0f0',
    selectionForeground: '#1a1a1a',
    black:         '#1a1a1a',
    red:           '#b91c1c',
    green:         '#15803d',
    yellow:        '#92570a',
    blue:          '#1d4ed8',
    magenta:       '#9d174d',
    cyan:          '#0e7490',
    white:         '#4a4a4a',
    brightBlack:   '#6b6b7b',
    brightRed:     '#dc2626',
    brightGreen:   '#16a34a',
    brightYellow:  '#b45309',
    brightBlue:    '#2563eb',
    brightMagenta: '#be185d',
    brightCyan:    '#0891b2',
    brightWhite:   '#111111',
  },
};

// Solarized Dark — canonical Ethan Schoonover values with two fixes:
//   1. brightBlack was #002b36 (= bg → invisible); now #586e75 (base01)
//   2. selectionBackground was #073642 (= sidebar → invisible selection)
// Accepted WCAG failures (Solarized low-contrast by design):
//   --danger #dc322f 3.25:1 · --accent #268bd2 4.08:1 · base00 text 3.37:1
const SOLARIZED_DARK: ThemeDef = {
  chromeClass: 'theme-solarized-dark',
  term: {
    background:          '#002b36',
    foreground:          '#839496',
    cursor:              '#93a1a1',
    cursorAccent:        '#002b36',
    selectionBackground: '#2d6a7f',
    selectionForeground: '#fdf6e3',
    black:         '#073642',
    red:           '#dc322f',
    green:         '#859900',
    yellow:        '#b58900',
    blue:          '#268bd2',
    magenta:       '#d33682',
    cyan:          '#2aa198',
    white:         '#eee8d5',
    brightBlack:   '#586e75',
    brightRed:     '#cb4b16',
    brightGreen:   '#586e75',
    brightYellow:  '#657b83',
    brightBlue:    '#839496',
    brightMagenta: '#6c71c4',
    brightCyan:    '#93a1a1',
    brightWhite:   '#fdf6e3',
  },
};

// High Contrast Dark — AAA contrast throughout. Overlay scale heavier
// than standard dark (0.05–0.30) because near-black surfaces need more
// alpha to produce visible hover/focus states.
const HC_DARK: ThemeDef = {
  chromeClass: 'theme-hc-dark',
  term: {
    background:          '#0a0a0a',
    foreground:          '#f0f0f0',
    cursor:              '#ffffff',
    cursorAccent:        '#0a0a0a',
    selectionBackground: '#2a5080',
    selectionForeground: '#ffffff',
    black:         '#404040',
    red:           '#ff4444',
    green:         '#00e676',
    yellow:        '#ffea00',
    blue:          '#448aff',
    magenta:       '#e040fb',
    cyan:          '#18ffff',
    white:         '#e0e0e0',
    brightBlack:   '#707070',
    brightRed:     '#ff6e6e',
    brightGreen:   '#69ff80',
    brightYellow:  '#ffff00',
    brightBlue:    '#82b1ff',
    brightMagenta: '#ea80fc',
    brightCyan:    '#84ffff',
    brightWhite:   '#ffffff',
  },
};

// High Contrast Light — all semantic colors achieve WCAG AAA on white.
const HC_LIGHT: ThemeDef = {
  chromeClass: 'theme-hc-light',
  term: {
    background:          '#ffffff',
    foreground:          '#000000',
    cursor:              '#000000',
    cursorAccent:        '#ffffff',
    selectionBackground: '#99bbff',
    selectionForeground: '#000000',
    black:         '#000000',
    red:           '#aa0000',
    green:         '#006600',
    yellow:        '#7a4000',
    blue:          '#0040cc',
    magenta:       '#880088',
    cyan:          '#007070',
    white:         '#444444',
    brightBlack:   '#444444',
    brightRed:     '#cc0000',
    brightGreen:   '#008800',
    brightYellow:  '#996600',
    brightBlue:    '#2255ee',
    brightMagenta: '#aa00aa',
    brightCyan:    '#009999',
    brightWhite:   '#111111',
  },
};

// Solarized Light — canonical Ethan Schoonover values.
// bright* slots follow canonical Solarized ANSI mapping (base colors in
// bright slots, not actual hues). Known breakage: git diff, ls colors,
// vim defaults will show neutral grays instead of bright colors.
// Accepted WCAG failures (Solarized low-contrast by design):
//   --text 4.52:1 · --text-dim 3.16:1 · --accent 3.27:1 · --warn 2.62:1
const SOLARIZED_LIGHT: ThemeDef = {
  chromeClass: 'theme-solarized-light',
  term: {
    background:          '#fdf6e3',
    foreground:          '#657b83',
    cursor:              '#586e75',
    cursorAccent:        '#fdf6e3',
    selectionBackground: '#268bd2',
    selectionForeground: '#fdf6e3',
    black:         '#073642',
    red:           '#dc322f',
    green:         '#859900',
    yellow:        '#b58900',
    blue:          '#268bd2',
    magenta:       '#d33682',
    cyan:          '#2aa198',
    white:         '#eee8d5',
    brightBlack:   '#839496',
    brightRed:     '#cb4b16',
    brightGreen:   '#586e75',
    brightYellow:  '#657b83',
    brightBlue:    '#839496',
    brightMagenta: '#6c71c4',
    brightCyan:    '#93a1a1',
    brightWhite:   '#eee8d5',
  },
};

export const THEMES: Record<ThemeName, ThemeDef> = {
  dark:             DARK,
  light:            LIGHT,
  'solarized-dark': SOLARIZED_DARK,
  'hc-dark':        HC_DARK,
  'hc-light':       HC_LIGHT,
  'solarized-light': SOLARIZED_LIGHT,
};

let current: ThemeName = 'dark';

function readStoredTheme(): ThemeName {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (
      v === 'dark' || v === 'light' || v === 'solarized-dark' ||
      v === 'hc-dark' || v === 'hc-light' || v === 'solarized-light'
    ) return v as ThemeName;
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

export function applyTheme(name: ThemeName) {
  current = name;
  const html = document.documentElement;
  for (const n of THEME_NAMES) {
    const cls = THEMES[n].chromeClass;
    if (cls) html.classList.remove(cls);
  }
  const cls = THEMES[name].chromeClass;
  if (cls) html.classList.add(cls);

  try {
    localStorage.setItem(LS_KEY, name);
  } catch {
    /* ignore */
  }

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

export function initTheme(): ThemeName {
  const name = readStoredTheme();
  applyTheme(name);
  return name;
}

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

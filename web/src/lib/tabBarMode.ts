export type TabBarMode = 'auto' | 'never' | 'always';

const KEY = 'tabBarMode';

export function loadTabBarMode(): TabBarMode {
  const v = localStorage.getItem(KEY);
  if (v === 'auto' || v === 'never' || v === 'always') return v;
  return 'auto';
}

export function saveTabBarMode(m: TabBarMode): void {
  localStorage.setItem(KEY, m);
}

type ModeMeta = { label: string; glyph: string; next: TabBarMode };

export const TAB_BAR_MODE_META: Record<TabBarMode, ModeMeta> = {
  auto:   { label: 'Auto (hide at 1 tab)',  glyph: '⊟', next: 'never'  },
  never:  { label: 'Never (always hidden)', glyph: '—', next: 'always' },
  always: { label: 'Always visible',        glyph: '☰', next: 'auto'   },
};

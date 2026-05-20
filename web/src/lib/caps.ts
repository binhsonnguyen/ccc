// PTY dimension caps. Global, persisted to localStorage. null = "max",
// i.e. follow viewport. When set, the terminal grid is clamped via
// term.resize() after FitAddon computes the viewport size.
//
// Validation bounds chosen so claude's TUI doesn't visibly break:
// below 20 cols / 5 rows it can't render its prompt + status line.
// Upper bound is sanity only — viewport caps it implicitly.

const COL_CAP_LS_KEY = 'c3:col-cap';
const ROW_CAP_LS_KEY = 'c3:row-cap';

export const COL_MIN = 20;
export const COL_MAX = 500;
export const ROW_MIN = 5;
export const ROW_MAX = 200;

function readCap(key: string, min: number, max: number): number | null {
  try {
    const v = localStorage.getItem(key);
    if (!v) return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return n;
  } catch {
    return null;
  }
}

function writeCap(key: string, n: number | null) {
  try {
    if (n == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}

export function readColCap(): number | null { return readCap(COL_CAP_LS_KEY, COL_MIN, COL_MAX); }
export function writeColCap(n: number | null) { writeCap(COL_CAP_LS_KEY, n); }
export function readRowCap(): number | null { return readCap(ROW_CAP_LS_KEY, ROW_MIN, ROW_MAX); }
export function writeRowCap(n: number | null) { writeCap(ROW_CAP_LS_KEY, n); }

export function clampCol(n: number): number {
  if (!Number.isFinite(n)) return COL_MIN;
  return Math.max(COL_MIN, Math.min(COL_MAX, Math.floor(n)));
}
export function clampRow(n: number): number {
  if (!Number.isFinite(n)) return ROW_MIN;
  return Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(n)));
}

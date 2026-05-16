import { useCallback, useEffect, useRef, useState } from 'react';
import { closeMenu, openMenu, subscribeMenu } from '../lib/menuController';

export interface MenuItem {
  id: string;
  label: string;
  // disabled items are still rendered (and visible to screen readers) but
  // not focusable and don't fire on click — matches WAI-ARIA menu pattern.
  disabled?: boolean;
  // danger mode triggers a second click before fire; menu item renders red
  // text. We delegate the "armed" state to the caller via onClick — the
  // caller can return false to keep menu open in armed state, true to
  // close. To keep this primitive simple we expose a `confirm` flavour
  // instead: when true, first click switches the item label to
  // confirmLabel and second click invokes onClick. Auto-disarm 3s.
  confirm?: boolean;
  confirmLabel?: string;
  // optional keyboard hint shown right-aligned (e.g. "⌘⌫").
  hint?: string;
  // separator: renders an hr; no other fields needed.
  separator?: boolean;
  onClick?: () => void;
}

interface Props {
  // unique id used by the menu controller — typically `menu-<sessionId>`.
  id: string;
  // anchor coordinates (page-relative). Provided by the row when opened
  // via right-click (cursor pos) or the ⋯ button (button rect).
  x: number;
  y: number;
  items: MenuItem[];
  // close fires after onClose-causing action (ESC, click-outside, item
  // selected). Caller restores focus to row.
  onClose: () => void;
}

// Single-instance menu. Render conditionally from caller; mounting it
// registers with the global controller so opening a second menu auto-
// closes the first.
export default function SessionRowMenu({ id, x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const [focusIdx, setFocusIdx] = useState<number>(() => {
    return items.findIndex((m) => !m.separator && !m.disabled);
  });
  // Adjusted coords after viewport clamping. Mount with anchor coords;
  // measure on layout and flip away from the right/bottom edge if needed.
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (ny + rect.height > window.innerHeight - margin) {
      ny = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
    // intentionally omit pos from deps — we set it inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  // Register with controller and react to other menus opening.
  useEffect(() => {
    openMenu(id);
    const unsub = subscribeMenu((openId) => {
      if (openId !== id) onClose();
    });
    return () => {
      unsub();
      closeMenu(id);
    };
  }, [id, onClose]);

  // Click-outside + ESC. Focus first focusable item on mount.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    const handle = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('contextmenu', onDocClick);
    }, 0);
    window.addEventListener('keydown', onKey);
    menuRef.current?.focus();
    return () => {
      window.clearTimeout(handle);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('contextmenu', onDocClick);
      window.removeEventListener('keydown', onKey);
      if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    };
  }, [onClose]);

  const focusable = items
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.separator && !m.disabled);

  const moveFocus = useCallback(
    (delta: number) => {
      if (focusable.length === 0) return;
      const curIdx = focusable.findIndex(({ i }) => i === focusIdx);
      const next = focusable[(curIdx + delta + focusable.length) % focusable.length];
      setFocusIdx(next.i);
    },
    [focusable, focusIdx],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (focusable[0]) setFocusIdx(focusable[0].i);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = focusable[focusable.length - 1];
      if (last) setFocusIdx(last.i);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = items[focusIdx];
      if (item && !item.separator) fireItem(item);
    }
  };

  const fireItem = useCallback(
    (item: MenuItem) => {
      if (item.disabled || item.separator) return;
      if (item.confirm) {
        if (armedId === item.id) {
          if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
          armTimerRef.current = null;
          setArmedId(null);
          item.onClick?.();
          onClose();
          return;
        }
        setArmedId(item.id);
        if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
        armTimerRef.current = window.setTimeout(() => {
          setArmedId(null);
          armTimerRef.current = null;
        }, 3000);
        return;
      }
      item.onClick?.();
      onClose();
    },
    [armedId, onClose],
  );

  // Viewport-aware positioning: avoid clipping at right/bottom edge.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: 0,
    top: 0,
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    zIndex: 90,
  };

  return (
    <div
      ref={menuRef}
      className="row-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={style}
      // Stop propagation so a right-click *inside* the menu doesn't
      // re-trigger the row's context handler.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={`sep-${i}`} className="row-menu-sep" role="separator" />;
        }
        const armed = armedId === item.id;
        const label = armed && item.confirmLabel ? item.confirmLabel : item.label;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={
              'row-menu-item' +
              (item.confirm ? ' is-danger' : '') +
              (armed ? ' is-armed' : '') +
              (focusIdx === i ? ' is-focused' : '')
            }
            tabIndex={-1}
            onMouseEnter={() => setFocusIdx(i)}
            onClick={(e) => {
              e.stopPropagation();
              fireItem(item);
            }}
          >
            <span className="row-menu-label">{label}</span>
            {item.hint && <span className="row-menu-hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastVariant = 'info' | 'warning' | 'error' | 'success';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  variant?: ToastVariant;
  // null → persistent (no auto-dismiss). undefined → variant default.
  timeout?: number | null;
  action?: ToastAction;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  timeout: number | null;
  action?: ToastAction;
  // wall-clock ms at which this toast should disappear; null when paused
  // (hover) or persistent.
  expiresAt: number | null;
  // ms of dismiss budget left when paused — used to recompute expiresAt
  // on un-hover.
  remaining: number | null;
}

interface ToastCtx {
  showToast: (message: string, opts?: ToastOptions) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const MAX = 3;

function defaultTimeout(v: ToastVariant): number {
  if (v === 'error' || v === 'warning') return 8000;
  return 5000;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, opts?: ToastOptions) => {
    const variant: ToastVariant = opts?.variant ?? 'info';
    const timeout =
      opts?.timeout === null
        ? null
        : opts?.timeout === undefined
          ? defaultTimeout(variant)
          : opts.timeout;
    const id = nextId.current++;
    setItems((prev) => {
      const now = Date.now();
      const item: ToastItem = {
        id,
        message,
        variant,
        timeout,
        action: opts?.action,
        expiresAt: timeout === null ? null : now + timeout,
        remaining: timeout,
      };
      // Cap at MAX; drop oldest.
      const next = [...prev, item];
      while (next.length > MAX) next.shift();
      return next;
    });
  }, []);

  // Single scheduling effect that walks the list and dismisses expired
  // toasts. Re-runs whenever items change (hover pause/resume re-mutates
  // expiresAt → triggers reschedule).
  useEffect(() => {
    const live = items.filter((t) => t.expiresAt !== null);
    if (live.length === 0) return;
    const soonest = Math.min(...live.map((t) => t.expiresAt as number));
    const wait = Math.max(0, soonest - Date.now());
    const handle = window.setTimeout(() => {
      const now = Date.now();
      setItems((prev) => prev.filter((t) => t.expiresAt === null || t.expiresAt > now));
    }, wait);
    return () => window.clearTimeout(handle);
  }, [items]);

  const pause = useCallback((id: number) => {
    setItems((prev) =>
      prev.map((t) => {
        if (t.id !== id || t.expiresAt === null) return t;
        const remaining = Math.max(0, t.expiresAt - Date.now());
        return { ...t, expiresAt: null, remaining };
      }),
    );
  }, []);

  const resume = useCallback((id: number) => {
    setItems((prev) =>
      prev.map((t) => {
        if (t.id !== id || t.timeout === null) return t;
        if (t.expiresAt !== null) return t;
        const rem = t.remaining ?? t.timeout;
        return { ...t, expiresAt: Date.now() + rem };
      }),
    );
  }, []);

  const value = useMemo<ToastCtx>(() => ({ showToast }), [showToast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.variant} show`}
            role={t.variant === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id)}
          >
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be inside ToastProvider');
  return v;
}

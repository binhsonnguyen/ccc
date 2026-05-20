import { useCallback, useEffect, useRef, useState } from 'react';
import { getOrCreateTerm } from '../lib/terminals';
import { fetchActivity, ptyWsURL, uploadImages } from '../lib/api';
import { useShortcut } from '../lib/shortcuts';
import { stripAnsi } from '../lib/ansi';
import { countMatches } from '../lib/mention';
import { paneId, tabId } from './TabBar';
import { useToast } from './Toast';
import type { ControlMsg, Tab, TabStatus } from '../types';

interface Props {
  tab: Tab;
  visible: boolean;
  onStatus: (uuid: string, status: TabStatus) => void;
  onKicked: (uuid: string) => void;
  onExit: (uuid: string, code: number) => void;
  onPending: (uuid: string) => void;
  onReady: (uuid: string) => void;
  // Server sent {type:"error",message}. Surface the message to the user;
  // ws.onclose will follow but should not overwrite the more-specific
  // error status (see App.onStatus guard).
  onError: (uuid: string, message: string) => void;
  onClose: (uuid: string) => void;
  // C-5: bump this tab's mention counter by `delta`. App is responsible
  // for ignoring bumps on the active tab (cheaper than threading the
  // active uuid through props — we also early-return below to skip the
  // decode entirely when this pane is visible).
  onMention: (uuid: string, delta: number) => void;
  // Global PTY dim caps. null = follow viewport. When set, we clamp the
  // xterm grid via term.resize() after FitAddon computes viewport dims,
  // then send the clamped values to the server. The xterm element keeps
  // its host-spanning size so the vertical scrollbar stays at the pane's
  // right edge; the grid simply doesn't render past `cap` columns.
  colCap: number | null;
  rowCap: number | null;
}

// Threshold beyond which we surface the "session idle" banner. 30 minutes
// matches the design — claude has typically wrapped a task and is sitting
// at its prompt by then. Kept as a module const (not a CSS var or env
// knob) so the scope stays tight; bump here if user feedback wants it.
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;
// How often we re-poll /activity for the idle counter. Matches the
// sidebar's sparkline cadence — server caches nothing per-request, so
// two clients polling at 2 s is fine.
const IDLE_POLL_MS = 2000;
// Window after a user-initiated reconnect during which we drop any
// {type:"exit"} frame. Covers the server's 5 s grace where it replays
// the cached exit to a re-attaching client. 500 ms is generous vs the
// few ms it takes for the WS to reach `connected` and the fresh PTY to
// start producing bytes; if a *real* exit happens later it'll be well
// outside the window.
const EXIT_SUPPRESS_MS = 500;

// humanizeIdle renders a millisecond duration as a compact, English-only
// "Xh Ym" / "Ym" / "Xs" string. Intentionally tiny — i18n is out of scope
// for v5 and the banner has at most ~20 chars to play with.
function humanizeIdle(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

// One pane per open tab. We render *all* panes simultaneously and hide
// the inactive ones with CSS, so switching tabs doesn't dispose xterm.
// The xterm instance lives in the out-of-tree Map (see lib/terminals.ts);
// effects here only attach DOM, wire WS, and bind input handlers.
export default function TerminalPane({
  tab,
  visible,
  onStatus,
  onKicked,
  onExit,
  onPending,
  onReady,
  onError,
  onClose,
  onMention,
  colCap,
  rowCap,
}: Props) {
  const { showToast } = useToast();

  // Timestamp of the most recent user-initiated reconnect (Restart shell /
  // Take over). The ws.onmessage exit handler suppresses {type:"exit"}
  // frames arriving within EXIT_SUPPRESS_MS of this moment — they are
  // typically the *cached* exit frame from the server's grace window
  // (5 s GC), not a fresh exit. Without this the overlay flickers off
  // → on → stuck after Restart shell.
  const lastReconnectAtRef = useRef(0);

  // True while a file drag is hovering this pane. Drives the drop-target
  // overlay. We count enter/leave events instead of using a single bool
  // because dragenter/leave fire on every child during traversal — a
  // bare bool would flicker. The counter goes to 0 when the drag truly
  // leaves the host.
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  // Refs mirror caps so callbacks captured by stale closures (ws.onopen,
  // ResizeObserver) always read the latest values without re-binding.
  const colCapRef = useRef(colCap);
  const rowCapRef = useRef(rowCap);
  useEffect(() => { colCapRef.current = colCap; }, [colCap]);
  useEffect(() => { rowCapRef.current = rowCap; }, [rowCap]);

  // fitAndSync: run FitAddon, clamp grid via term.resize() against the
  // current caps, and ship the resulting dims to the server when they
  // differ from the last sent values. Single funnel so ws.onopen, the
  // ResizeObserver, the visibility effect, and the caps-changed effect
  // all behave identically.
  const fitAndSync = useCallback((uuid: string) => {
    const entry = getOrCreateTerm(uuid);
    try { entry.fit.fit(); } catch { /* container may be 0x0 */ }
    const natCols = entry.term.cols;
    const natRows = entry.term.rows;
    const cc = colCapRef.current;
    const rc = rowCapRef.current;
    const cols = cc != null && natCols > cc ? cc : natCols;
    const rows = rc != null && natRows > rc ? rc : natRows;
    if (cols !== natCols || rows !== natRows) {
      try { entry.term.resize(cols, rows); } catch { /* ignore */ }
    }
    if (cols === entry.lastCols && rows === entry.lastRows) return;
    entry.lastCols = cols;
    entry.lastRows = rows;
    const ws = entry.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const primaryBtnRef = useRef<HTMLButtonElement | null>(null);
  // visibleRef mirrors `visible` so the WS onmessage handler (captured
  // once when openWS runs) can early-return for the active tab without
  // re-binding on every visibility flip.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  // Decoder reused across frames — TextDecoder allocates a small
  // amount per construction, so we hoist it.
  const decoderRef = useRef<TextDecoder | null>(null);
  if (decoderRef.current === null) {
    decoderRef.current = new TextDecoder('utf-8', { fatal: false });
  }
  // Track whether WS setup has run for this uuid in this component
  // instance. React StrictMode double-invokes effects in dev; the global
  // term Map already guarantees a single xterm, but we also want to
  // avoid two concurrent WebSockets to the same uuid.
  //
  // CRITICAL: cleanup must reset this to false. Otherwise StrictMode's
  // unmount→remount cycle leaves it stuck true and the second mount
  // skips openWS — tab stays "connecting" forever in dev.
  const wsBoundRef = useRef(false);

  // openWS is the canonical "(re)attach to this PTY" routine.
  const openWS = useCallback(
    (uuid: string, c3Id: string) => {
      const entry = getOrCreateTerm(uuid);
      if (entry.ws) {
        try {
          entry.ws.close();
        } catch {
          /* ignore */
        }
        entry.ws = null;
      }
      entry.term.reset();

      const ws = new WebSocket(ptyWsURL(c3Id));
      ws.binaryType = 'arraybuffer';
      entry.ws = ws;
      onStatus(uuid, 'connecting');

      ws.onopen = () => {
        onStatus(uuid, 'connected');
        // Reset lastCols/Rows so fitAndSync is guaranteed to ship the
        // initial dims (otherwise a reconnect with unchanged size would
        // skip the resize frame).
        entry.lastCols = -1;
        entry.lastRows = -1;
        fitAndSync(uuid);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let msg: ControlMsg | null = null;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (!msg) return;
          if (msg.type === 'kicked') onKicked(uuid);
          else if (msg.type === 'exit') {
            // Suppress cached exit frames replayed within the server's
            // grace window right after a user-initiated reconnect.
            if (Date.now() - lastReconnectAtRef.current < EXIT_SUPPRESS_MS) {
              /* swallow */
            } else {
              onExit(uuid, msg.code);
            }
          }
          else if (msg.type === 'error') {
            // Server failed to attach (e.g. claude not in PATH). Surface
            // the real message — ws.onclose will fire right after but the
            // App.onStatus guard keeps us from getting downgraded to a
            // generic "Disconnected".
            onError(uuid, msg.message || 'attach failed');
          } else if (msg.type === 'pending') {
            // Server is spawning `claude` no-resume. We used to disable
            // stdin here on the theory that early keystrokes would be
            // lost before the child set up its PTY, but that created a
            // deadlock with modern Claude Code: claude only writes its
            // JSONL after the first user message, so the discovery
            // loop's pending→ready transition would never fire and the
            // user couldn't type to unblock it. The pending banner is
            // enough of a visual cue; let the user type.
            onPending(uuid);
          } else if (msg.type === 'ready') {
            // Defensive: re-enable stdin in case some earlier code path
            // (or older bundle in another tab) had disabled it.
            entry.term.options.disableStdin = false;
            onReady(uuid);
          }
          return;
        }
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        entry.term.write(bytes);
        // C-5: count mention regex hits, but only on inactive tabs —
        // for the visible tab the user is already watching the output
        // and a badge would be redundant. Skip the decode entirely on
        // the hot path when this pane is the active one.
        if (!visibleRef.current) {
          try {
            // stream:false on purpose. The default regex matches ASCII
            // tokens (Error/TODO/FIXME); decoder state leak across the
            // visible→hidden boundary would chop the first bytes of a
            // frame we *do* want to scan. The mention pass is best-effort
            // anyway — a multi-byte char straddling frames just won't be
            // part of the match.
            const text = decoderRef.current!.decode(bytes);
            const n = countMatches(stripAnsi(text));
            if (n > 0) onMention(uuid, n);
          } catch {
            /* malformed frame: don't break the terminal write path */
          }
        }
      };
      ws.onclose = () => {
        if (entry.ws === ws) entry.ws = null;
        onStatus(uuid, 'disconnected');
      };
      ws.onerror = () => onStatus(uuid, 'error');
    },
    [onStatus, onKicked, onExit, onPending, onReady, onError, onMention, fitAndSync],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = getOrCreateTerm(tab.claudeUuid);

    if (entry.container !== host) {
      const el = entry.term.element;
      if (el && el.parentElement !== host) {
        host.appendChild(el);
      } else if (!el) {
        entry.term.open(host);
      }
      entry.container = host;
    }
    try {
      entry.fit.fit();
    } catch {
      /* container may be 0x0 momentarily */
    }

    const dataDisposable = entry.term.onData((s: string) => {
      const ws = entry.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(s));
      }
    });

    const ro = new ResizeObserver(() => {
      if (entry.resizeTimer) window.clearTimeout(entry.resizeTimer);
      entry.resizeTimer = window.setTimeout(() => {
        fitAndSync(tab.claudeUuid);
      }, 80);
    });
    ro.observe(host);

    if (!wsBoundRef.current) {
      wsBoundRef.current = true;
      openWS(tab.claudeUuid, tab.c3Id);
    }

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      const ws = entry.ws;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      entry.ws = null;
      wsBoundRef.current = false;
    };
  }, [tab.claudeUuid, tab.c3Id, openWS]);

  // ---- clipboard image paste + drag-drop -----------------------------
  // Intercept paste/drop on the terminal host BEFORE xterm sees them.
  // When the payload contains image blobs, upload to the server (which
  // writes them under ~/.local/share/c3/<id>/images/) and inject the
  // returned absolute paths into stdin as `@<path> ` — claude treats
  // these as normal @mentions and reads the file from disk. Plain-text
  // pastes fall through to xterm's default handling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sendStdin = (s: string) => {
      const entry = getOrCreateTerm(tab.claudeUuid);
      const ws = entry.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(s));
      }
    };

    const collectImages = (dt: DataTransfer | null): File[] => {
      if (!dt) return [];
      const out: File[] = [];
      if (dt.items && dt.items.length > 0) {
        for (let i = 0; i < dt.items.length; i++) {
          const it = dt.items[i];
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) out.push(f);
          }
        }
      }
      if (out.length === 0 && dt.files && dt.files.length > 0) {
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          if (f.type.startsWith('image/')) out.push(f);
        }
      }
      return out;
    };

    const injectPaths = async (files: File[]) => {
      try {
        const paths = await uploadImages(tab.c3Id, files);
        for (const p of paths) {
          sendStdin(`@${p} `);
        }
        const n = paths.length;
        showToast(n === 1 ? 'Added 1 image' : `Added ${n} images`, {
          variant: 'success',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('c3: image upload failed', e);
        showToast(`Image upload failed — ${msg}`, { variant: 'error' });
      }
    };

    const hasFileDrag = (dt: DataTransfer | null): boolean => {
      if (!dt) return false;
      // `types` is a DOMStringList in some browsers, array in others.
      // Array.from normalises and avoids includes() being unavailable.
      return Array.from(dt.types).includes('Files');
    };

    const onPaste = (ev: ClipboardEvent) => {
      const files = collectImages(ev.clipboardData);
      if (files.length === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      void injectPaths(files);
    };

    const onDragEnter = (ev: DragEvent) => {
      if (!hasFileDrag(ev.dataTransfer)) return;
      dragDepthRef.current += 1;
      if (dragDepthRef.current === 1) setDragActive(true);
    };

    const onDragOver = (ev: DragEvent) => {
      if (!hasFileDrag(ev.dataTransfer)) return;
      ev.preventDefault();
      ev.dataTransfer!.dropEffect = 'copy';
    };

    const onDragLeave = (ev: DragEvent) => {
      if (!hasFileDrag(ev.dataTransfer)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };

    const onDrop = (ev: DragEvent) => {
      // Always reset overlay state on drop — even when no images so the
      // visual cue clears.
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = collectImages(ev.dataTransfer);
      if (files.length === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      void injectPaths(files);
    };

    // Capture phase so we run before xterm's own paste listener on its
    // helper textarea. preventDefault + stopPropagation then keeps xterm
    // from also pasting the (empty) text representation.
    host.addEventListener('paste', onPaste, true);
    host.addEventListener('dragenter', onDragEnter);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);
    return () => {
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('dragenter', onDragEnter);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
    };
  }, [tab.c3Id, tab.claudeUuid, showToast]);

  useEffect(() => {
    if (!visible) return;
    fitAndSync(tab.claudeUuid);
  }, [visible, tab.claudeUuid, fitAndSync]);

  // Caps change → re-fit + re-resize + ship new dims. fit() is
  // idempotent and lastCols/Rows gate the ws send, so nothing is wasted
  // if the grid didn't actually move.
  useEffect(() => {
    if (!visible) return;
    fitAndSync(tab.claudeUuid);
  }, [colCap, rowCap, visible, tab.claudeUuid, fitAndSync]);

  const reconnect = useCallback(
    () => {
      lastReconnectAtRef.current = Date.now();
      openWS(tab.claudeUuid, tab.c3Id);
    },
    [openWS, tab.claudeUuid, tab.c3Id],
  );

  const terminalDead = tab.status === 'kicked' || tab.status === 'exited';
  const transportProblem = tab.status === 'disconnected' || tab.status === 'error';

  // ---- idle-PTY banner -------------------------------------------------
  // Poll /activity (which already returns idleMs server-side, measured
  // against the PTY's wall clock — no client-skew issues) and surface a
  // non-blocking banner when claude has been quiet for >IDLE_THRESHOLD_MS.
  // Per-tab state intentionally lives here (not lifted to App) so closing
  // and reopening a tab gives a fresh slate.
  const [idleMs, setIdleMs] = useState(0);
  const [idleDismissed, setIdleDismissed] = useState(false);
  const [sendDisabled, setSendDisabled] = useState(false);

  useEffect(() => {
    // Only poll while connected and only for sessions that already have
    // a live PTY (uuid known). Pending/dead/transport-broken tabs have
    // no idle signal to report.
    if (tab.status !== 'connected') return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetchActivity(tab.c3Id);
        if (cancelled) return;
        if (!r) {
          // No live PTY (server 204) — clear any stale state.
          setIdleMs(0);
          return;
        }
        setIdleMs((prev) => {
          // Auto-reset the dismissed flag when fresh activity arrives:
          // if we were above threshold and now we're well below it, the
          // user's next idle stretch should be allowed to surface again.
          if (prev >= IDLE_THRESHOLD_MS && r.idleMs < IDLE_THRESHOLD_MS) {
            setIdleDismissed(false);
          }
          return r.idleMs;
        });
      } catch {
        /* ignore poll failures — next tick will retry */
      }
    };
    void tick();
    const h = window.setInterval(() => void tick(), IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(h);
    };
  }, [tab.status, tab.c3Id]);

  const idleBannerVisible =
    visible &&
    tab.status === 'connected' &&
    !terminalDead &&
    !transportProblem &&
    !idleDismissed &&
    idleMs >= IDLE_THRESHOLD_MS;

  const sendWake = useCallback(() => {
    const entry = getOrCreateTerm(tab.claudeUuid);
    const ws = entry.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // 0x0D = CR. Claude's prompt treats this as "submit empty line",
      // which redraws and re-reads from stdin — exactly the "wake up"
      // gesture the user would otherwise type by hand.
      ws.send(new Uint8Array([0x0d]));
    }
    setIdleDismissed(true);
    // Visual debounce so a frantic double-click doesn't spam multiple
    // CRs visually (the byte is harmless either way).
    setSendDisabled(true);
    window.setTimeout(() => setSendDisabled(false), 1000);
  }, [tab.claudeUuid]);

  // Autofocus the primary action when the terminal-dead overlay shows.
  // The inline banner does not trap focus by design.
  useEffect(() => {
    if (!visible || !terminalDead) return;
    primaryBtnRef.current?.focus();
  }, [visible, terminalDead]);

  // ESC dismisses the terminal-dead overlay. Migrated to the shortcut
  // registry (PLAN.md P-3). The `when` predicate keeps each pane's
  // entry inert unless this pane is the visible one and is actually
  // showing the overlay — so two open tabs don't both fire.
  useShortcut(
    {
      id: `pane.close.${tab.claudeUuid}`,
      keys: 'Escape',
      scope: 'global',
      label: 'Dismiss terminal-dead overlay',
      when: () => visible && terminalDead,
      handler: () => onClose(tab.claudeUuid),
    },
    [visible, terminalDead, tab.claudeUuid, onClose],
  );

  return (
    <div
      className={'pane' + (visible ? '' : ' hidden')}
      id={paneId(tab.claudeUuid)}
      role="tabpanel"
      aria-labelledby={tabId(tab.claudeUuid)}
    >
      {tab.status === 'pending' && visible && (
        <div className="inline-banner banner-pending" role="status">
          <span className="banner-icon" aria-hidden="true">
            <span className="spinner" />
          </span>
          <span className="banner-text">
            New session — type a message to start. The session uuid is
            assigned once claude writes its first JSONL.
          </span>
        </div>
      )}
      {transportProblem && visible && (
        <div
          className={'inline-banner banner-' + (tab.status === 'error' ? 'error' : 'warn')}
          role="status"
        >
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <span className="banner-text">
            {tab.status === 'error'
              ? tab.errorMessage
                ? `Attach failed: ${tab.errorMessage}`
                : 'Connection error — server closed the WebSocket.'
              : 'Disconnected — PTY may still be running.'}
          </span>
          <button className="btn btn-sm primary" onClick={reconnect}>
            Reconnect
          </button>
          <button
            className="btn btn-sm"
            onClick={() => onClose(tab.claudeUuid)}
            aria-label="Dismiss and close tab"
          >
            Close
          </button>
        </div>
      )}
      {idleBannerVisible && (
        <div
          className="inline-banner banner-warn banner-idle"
          role="status"
          aria-live="polite"
        >
          <span className="banner-icon" aria-hidden="true">⏸</span>
          <span className="banner-text">
            Session idle for {humanizeIdle(idleMs)} — claude may be waiting for input.
          </span>
          <button
            className="btn btn-sm primary"
            onClick={sendWake}
            disabled={sendDisabled}
          >
            Send Enter
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setIdleDismissed(true)}
            aria-label="Dismiss idle banner"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="pane-host-inner" ref={hostRef}>
        {dragActive && (
          <div className="drop-target" aria-hidden="true">
            <div className="drop-target-text">Drop image to attach</div>
          </div>
        )}
      </div>
      {tab.status === 'kicked' && visible && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={`kicked-${tab.claudeUuid}`}>
          <div className="overlay-card">
            <h2 id={`kicked-${tab.claudeUuid}`}>Session opened elsewhere</h2>
            <p>
              This PTY is now attached to another window. Take over to bring it back
              here, or close this tab.
            </p>
            <div className="overlay-actions">
              <button ref={primaryBtnRef} className="btn primary" onClick={reconnect}>
                Take over
              </button>
              <button className="btn" onClick={() => onClose(tab.claudeUuid)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {tab.status === 'exited' && visible && (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby={`exited-${tab.claudeUuid}`}>
          <div className="overlay-card">
            {tab.kind === 'shell' ? (
              <>
                <h2 id={`exited-${tab.claudeUuid}`}>
                  Shell exited (code {tab.exitCode ?? '?'})
                </h2>
                <p>
                  Restart spawns a fresh shell in the same cwd. Scrollback
                  from the previous session is not preserved.
                </p>
                <div className="overlay-actions">
                  <button
                    ref={primaryBtnRef}
                    className="btn primary"
                    onClick={reconnect}
                    aria-label="Restart shell"
                  >
                    Restart shell
                  </button>
                  <button
                    className="btn"
                    onClick={() => onClose(tab.claudeUuid)}
                  >
                    Close tab
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id={`exited-${tab.claudeUuid}`}>claude exited</h2>
                <p>Exit code {tab.exitCode ?? '?'}.</p>
                <div className="overlay-actions">
                  <button
                    ref={primaryBtnRef}
                    className="btn"
                    onClick={() => onClose(tab.claudeUuid)}
                  >
                    Close tab
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

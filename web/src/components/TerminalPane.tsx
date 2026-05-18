import { useCallback, useEffect, useRef } from 'react';
import { getOrCreateTerm } from '../lib/terminals';
import { ptyWsURL } from '../lib/api';
import { useShortcut } from '../lib/shortcuts';
import { stripAnsi } from '../lib/ansi';
import { countMatches } from '../lib/mention';
import { paneId, tabId } from './TabBar';
import type { ControlMsg, Tab, TabStatus } from '../types';

interface Props {
  tab: Tab;
  visible: boolean;
  onStatus: (uuid: string, status: TabStatus) => void;
  onKicked: (uuid: string) => void;
  onExit: (uuid: string, code: number) => void;
  onPending: (uuid: string) => void;
  onReady: (uuid: string) => void;
  onClose: (uuid: string) => void;
  // C-5: bump this tab's mention counter by `delta`. App is responsible
  // for ignoring bumps on the active tab (cheaper than threading the
  // active uuid through props — we also early-return below to skip the
  // decode entirely when this pane is visible).
  onMention: (uuid: string, delta: number) => void;
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
  onClose,
  onMention,
}: Props) {
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
        try {
          entry.fit.fit();
        } catch {
          /* ignore */
        }
        const cols = entry.term.cols;
        const rows = entry.term.rows;
        entry.lastCols = cols;
        entry.lastRows = rows;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
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
          else if (msg.type === 'exit') onExit(uuid, msg.code);
          else if (msg.type === 'pending') {
            // Server is spawning `claude` no-resume; disable input until
            // ready arrives so we don't lose keystrokes the runner won't
            // route to the not-yet-launched child.
            entry.term.options.disableStdin = true;
            onPending(uuid);
          } else if (msg.type === 'ready') {
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
    [onStatus, onKicked, onExit, onPending, onReady, onMention],
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
      try {
        entry.fit.fit();
      } catch {
        /* ignore */
      }
      if (entry.resizeTimer) window.clearTimeout(entry.resizeTimer);
      entry.resizeTimer = window.setTimeout(() => {
        const cols = entry.term.cols;
        const rows = entry.term.rows;
        if (cols === entry.lastCols && rows === entry.lastRows) return;
        entry.lastCols = cols;
        entry.lastRows = rows;
        const ws = entry.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
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

  useEffect(() => {
    if (!visible) return;
    const entry = getOrCreateTerm(tab.claudeUuid);
    try {
      entry.fit.fit();
    } catch {
      /* ignore */
    }
    const cols = entry.term.cols;
    const rows = entry.term.rows;
    if (cols === entry.lastCols && rows === entry.lastRows) return;
    entry.lastCols = cols;
    entry.lastRows = rows;
    const ws = entry.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, [visible, tab.claudeUuid]);

  const reconnect = useCallback(
    () => openWS(tab.claudeUuid, tab.c3Id),
    [openWS, tab.claudeUuid, tab.c3Id],
  );

  const terminalDead = tab.status === 'kicked' || tab.status === 'exited';
  const transportProblem = tab.status === 'disconnected' || tab.status === 'error';

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
            Starting Claude — waiting for session uuid…
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
              ? 'Connection error — server closed the WebSocket.'
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
      <div className="pane-host-inner" ref={hostRef} />
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
            <h2 id={`exited-${tab.claudeUuid}`}>claude exited</h2>
            <p>Exit code {tab.exitCode ?? '?'}.</p>
            <div className="overlay-actions">
              <button ref={primaryBtnRef} className="btn" onClick={() => onClose(tab.claudeUuid)}>
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

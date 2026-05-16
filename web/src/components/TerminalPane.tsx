import { useCallback, useEffect, useRef } from 'react';
import { getOrCreateTerm } from '../lib/terminals';
import { ptyWsURL } from '../lib/api';
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
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const primaryBtnRef = useRef<HTMLButtonElement | null>(null);
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
    (uuid: string, c2Id: string) => {
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

      const ws = new WebSocket(ptyWsURL(c2Id));
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
        entry.term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (entry.ws === ws) entry.ws = null;
        onStatus(uuid, 'disconnected');
      };
      ws.onerror = () => onStatus(uuid, 'error');
    },
    [onStatus, onKicked, onExit, onPending, onReady],
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
      openWS(tab.claudeUuid, tab.c2Id);
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
  }, [tab.claudeUuid, tab.c2Id, openWS]);

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
    () => openWS(tab.claudeUuid, tab.c2Id),
    [openWS, tab.claudeUuid, tab.c2Id],
  );

  const terminalDead = tab.status === 'kicked' || tab.status === 'exited';
  const transportProblem = tab.status === 'disconnected' || tab.status === 'error';

  // ESC + autofocus only for the terminal-dead overlay. The inline banner
  // does not trap focus by design.
  useEffect(() => {
    if (!visible || !terminalDead) return;
    primaryBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(tab.claudeUuid);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, terminalDead, tab.claudeUuid, onClose]);

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

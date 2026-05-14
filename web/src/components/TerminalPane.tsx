import { useCallback, useEffect, useRef } from 'react';
import { getOrCreateTerm } from '../lib/terminals';
import { ptyWsURL } from '../lib/api';
import type { ControlMsg, Tab, TabStatus } from '../types';

interface Props {
  tab: Tab;
  visible: boolean;
  onStatus: (uuid: string, status: TabStatus) => void;
  onKicked: (uuid: string) => void;
  onExit: (uuid: string, code: number) => void;
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
  onClose,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Track whether WS setup has run for this uuid in this component
  // instance. React StrictMode double-invokes effects in dev; the global
  // term Map already guarantees a single xterm, but we also want to
  // avoid two concurrent WebSockets to the same uuid.
  //
  // CRITICAL: cleanup must reset this to false. Otherwise StrictMode's
  // unmount→remount cycle leaves it stuck true and the second mount
  // skips openWS — tab stays "connecting" forever in dev.
  const wsBoundRef = useRef(false);

  // openWS is the canonical "(re)attach to this PTY" routine. Used by:
  //   - initial mount effect
  //   - Take over button (after kicked)
  //   - Reconnect button (after disconnected/error)
  // The server replays scrollback on every fresh attach, so callers
  // *must* clear the terminal first or the user sees duplicated output.
  const openWS = useCallback(
    (uuid: string) => {
      const entry = getOrCreateTerm(uuid);
      // Tear down any leftover socket. Idempotent: noop if already null.
      if (entry.ws) {
        try {
          entry.ws.close();
        } catch {
          /* ignore */
        }
        entry.ws = null;
      }
      // Wipe screen + scrollback before replay arrives. reset() is
      // stronger than clear() — drops alt-screen state too, which
      // matters because claude often runs in alt-screen.
      entry.term.reset();

      const ws = new WebSocket(ptyWsURL(uuid));
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
          return;
        }
        entry.term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (entry.ws === ws) entry.ws = null;
        // App.onStatus refuses to overwrite 'kicked'/'exited', so this
        // is safe even if a control frame arrived just before close.
        onStatus(uuid, 'disconnected');
      };
      ws.onerror = () => onStatus(uuid, 'error');
    },
    [onStatus, onKicked, onExit],
  );

  // Mount xterm into our host div + open the WebSocket. We do this once
  // per Tab lifetime; tab close (parent removes the component) triggers
  // cleanup which closes the WS.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = getOrCreateTerm(tab.claudeUuid);

    // Idempotent open: only call term.open(host) when not yet attached
    // or when re-attaching to a fresh host (e.g. after StrictMode remount).
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

    // ---- input wiring (xterm → ws) ----------------------------------
    const dataDisposable = entry.term.onData((s: string) => {
      const ws = entry.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(s));
      }
    });

    // ---- resize observer --------------------------------------------
    // Debounce: dragging the splitter fires dozens of events/sec, each
    // round-trips to ioctl + SIGWINCH inside claude. 80ms feels instant.
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

    // ---- WebSocket --------------------------------------------------
    if (!wsBoundRef.current) {
      wsBoundRef.current = true;
      openWS(tab.claudeUuid);
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
      // RESET so StrictMode's remount can rebind. See ref comment above.
      wsBoundRef.current = false;
    };
  }, [tab.claudeUuid, openWS]);

  // C1: when tab becomes visible after being hidden, the container size
  // may have changed (window resized while we were display:none).
  // ResizeObserver doesn't fire on display toggles, so refit manually.
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

  const reconnect = useCallback(() => openWS(tab.claudeUuid), [openWS, tab.claudeUuid]);

  return (
    <div className={'pane' + (visible ? '' : ' hidden')}>
      <div className="pane-host-inner" ref={hostRef} />
      {tab.status === 'kicked' && visible && (
        <div className="overlay">
          <div className="overlay-card">
            <h2>Session opened elsewhere</h2>
            <p>
              This PTY is now attached to another window. Take over to bring it back
              here, or close this tab.
            </p>
            <div className="overlay-actions">
              <button className="btn primary" onClick={reconnect}>
                Take over
              </button>
              <button className="btn" onClick={() => onClose(tab.claudeUuid)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {(tab.status === 'disconnected' || tab.status === 'error') && visible && (
        <div className="overlay">
          <div className="overlay-card">
            <h2>{tab.status === 'error' ? 'Connection error' : 'Disconnected'}</h2>
            <p>
              The server closed the WebSocket. The PTY may still be running —
              reconnect to replay scrollback.
            </p>
            <div className="overlay-actions">
              <button className="btn primary" onClick={reconnect}>
                Reconnect
              </button>
              <button className="btn" onClick={() => onClose(tab.claudeUuid)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {tab.status === 'exited' && visible && (
        <div className="overlay">
          <div className="overlay-card">
            <h2>claude exited</h2>
            <p>Exit code {tab.exitCode ?? '?'}.</p>
            <div className="overlay-actions">
              <button className="btn" onClick={() => onClose(tab.claudeUuid)}>
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// SplitContainer renders one or two TerminalPane children with a
// drag-resizable divider between them. Horizontal-only in v0.2.23.
// Kind picking happens at the tab-strip split menu (TabBar), so this
// component doesn't own any picker UI.

import { useCallback, useRef, useState } from 'react';
import TerminalPane from './TerminalPane';
import type { Pane, Tab, TabStatus } from '../types';

interface Props {
  tab: Tab;
  visible: boolean;
  onStatus: (uuid: string, status: TabStatus) => void;
  onKicked: (uuid: string) => void;
  onExit: (uuid: string, code: number) => void;
  onPending: (uuid: string) => void;
  onReady: (uuid: string) => void;
  onError: (uuid: string, message: string) => void;
  onClosePane: (c3Id: string) => void;
  onMention: (uuid: string, delta: number) => void;
  onFocusPane: (c3Id: string) => void;
  onRatioChange: (tabId: string, ratio: number) => void;
  colCap: number | null;
  rowCap: number | null;
}

const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;
const clampRatio = (r: number) => Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));

export default function SplitContainer(props: Props) {
  const {
    tab,
    visible,
    onClosePane,
    onFocusPane,
    onRatioChange,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number; total: number } | null>(null);
  // Live drag ratio mirror so we avoid React re-renders on every
  // pointermove (we apply via CSS var instead).
  const [draggingRatio, setDraggingRatio] = useState<number | null>(null);

  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (tab.panes.length !== 2) return;
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      dragRef.current = { startX: e.clientX, startW: rect.width * tab.ratio, total: rect.width };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [tab.panes.length, tab.ratio],
  );
  const onDividerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const next = clampRatio((d.startW + dx) / d.total);
    setDraggingRatio(next);
  }, []);
  const onDividerPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (d == null) return;
      const finalRatio = draggingRatio;
      setDraggingRatio(null);
      if (finalRatio != null) onRatioChange(tab.id, finalRatio);
    },
    [draggingRatio, onRatioChange, tab.id],
  );
  const onDividerDoubleClick = useCallback(() => {
    onRatioChange(tab.id, 0.5);
  }, [onRatioChange, tab.id]);

  const renderPane = (pane: Pane, idx: 0 | 1) => {
    const isMulti = tab.panes.length === 2;
    const focused = isMulti && tab.focusedPaneIdx === idx;
    return (
      <div
        className={'split-cell' + (focused ? ' pane-focused' : '')}
        onMouseDownCapture={() => onFocusPane(pane.c3Id)}
      >
        <TerminalPane
          pane={pane}
          visible={visible}
          focused={focused || !isMulti}
          onFocus={() => onFocusPane(pane.c3Id)}
          onStatus={props.onStatus}
          onKicked={props.onKicked}
          onExit={props.onExit}
          onPending={props.onPending}
          onReady={props.onReady}
          onError={props.onError}
          onClose={onClosePane}
          onMention={props.onMention}
          colCap={props.colCap}
          rowCap={props.rowCap}
          // Show per-pane close button only when split (≥2 panes).
          // Single-pane tabs use the tab-strip × — adding another inside
          // the pane would duplicate the affordance.
          showPaneCloseButton={isMulti}
        />
      </div>
    );
  };

  // Live ratio drives the CSS grid via custom property. We re-read it
  // from state during drag (cheap; the cell renders are isolated).
  const effectiveRatio = draggingRatio ?? tab.ratio;
  const cssRatio = `${(effectiveRatio * 100).toFixed(2)}%`;

  if (tab.panes.length === 1) {
    return (
      <div
        ref={rootRef}
        className={'split split-h split-single' + (visible ? '' : ' hidden')}
      >
        {renderPane(tab.panes[0], 0)}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={'split split-h' + (visible ? '' : ' hidden')}
      style={{ ['--split-ratio' as string]: cssRatio } as React.CSSProperties}
    >
      {renderPane(tab.panes[0], 0)}
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onDoubleClick={onDividerDoubleClick}
        title="Drag to resize · double-click to reset"
      />
      {renderPane(tab.panes[1]!, 1)}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  COL_MAX,
  COL_MIN,
  ROW_MAX,
  ROW_MIN,
  clampCol,
  clampRow,
} from '../lib/caps';

interface Props {
  open: boolean;
  // Current applied values; the dialog seeds its draft state from these
  // each time it opens, so Cancel discards in-flight edits.
  colCap: number | null;
  rowCap: number | null;
  // Live viewport dims, for the "Max (NN)" labels. May be 0 if no tab
  // is connected yet — we just omit the parenthetical in that case.
  viewportCols: number;
  viewportRows: number;
  onApply: (colCap: number | null, rowCap: number | null) => void;
  onClose: () => void;
}

// Small reusable row: one axis (cols or rows). Two radios — Max vs
// Custom — and a number input that's only enabled in Custom mode.
function DimRow({
  axisLabel,
  mode,
  setMode,
  value,
  setValue,
  min,
  max,
  viewport,
  idPrefix,
}: {
  axisLabel: string;
  mode: 'max' | 'custom';
  setMode: (m: 'max' | 'custom') => void;
  value: number;
  setValue: (n: number) => void;
  min: number;
  max: number;
  viewport: number;
  idPrefix: string;
}) {
  const maxLabel = viewport > 0 ? `Max (${viewport})` : 'Max';
  return (
    <fieldset className="dims-row">
      <legend>{axisLabel}</legend>
      <label className="dims-radio">
        <input
          type="radio"
          name={`${idPrefix}-mode`}
          checked={mode === 'max'}
          onChange={() => setMode('max')}
        />
        <span>{maxLabel}</span>
      </label>
      <label className="dims-radio">
        <input
          type="radio"
          name={`${idPrefix}-mode`}
          checked={mode === 'custom'}
          onChange={() => setMode('custom')}
        />
        <span>Custom</span>
        <input
          type="number"
          className="dims-input"
          min={min}
          max={max}
          step={1}
          value={value}
          disabled={mode === 'max'}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            setValue(Number.isFinite(n) ? n : min);
          }}
          onFocus={() => setMode('custom')}
        />
      </label>
      <span className="dims-hint">{min}–{max}</span>
    </fieldset>
  );
}

export default function PtyDimsDialog({
  open,
  colCap,
  rowCap,
  viewportCols,
  viewportRows,
  onApply,
  onClose,
}: Props) {
  // Draft state. Initialized from props on each open so Cancel resets.
  const [colMode, setColMode] = useState<'max' | 'custom'>(colCap == null ? 'max' : 'custom');
  const [rowMode, setRowMode] = useState<'max' | 'custom'>(rowCap == null ? 'max' : 'custom');
  // Custom value defaults to current cap, or current viewport if "Max" is
  // selected (so flipping to Custom shows a sensible starting number).
  const [colVal, setColVal] = useState<number>(colCap ?? (viewportCols || 100));
  const [rowVal, setRowVal] = useState<number>(rowCap ?? (viewportRows || 30));

  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Re-seed every open. open=false→true edge captures whatever the user
  // last applied (props) as the new draft baseline.
  useEffect(() => {
    if (!open) return;
    setColMode(colCap == null ? 'max' : 'custom');
    setRowMode(rowCap == null ? 'max' : 'custom');
    setColVal(colCap ?? (viewportCols || 100));
    setRowVal(rowCap ?? (viewportRows || 30));
  }, [open, colCap, rowCap, viewportCols, viewportRows]);

  // Esc closes; click outside the card closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const handleApply = () => {
    const nextCol = colMode === 'max' ? null : clampCol(colVal);
    const nextRow = rowMode === 'max' ? null : clampRow(rowVal);
    onApply(nextCol, nextRow);
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="modal-card dims-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dims-dialog-title"
      >
        <h2 id="dims-dialog-title" className="modal-title">Terminal dimensions</h2>
        <p className="modal-help">
          Cap the PTY grid below the viewport so long lines wrap at a
          comfortable width. Applies to all tabs.
        </p>

        <DimRow
          axisLabel="Max columns"
          mode={colMode}
          setMode={setColMode}
          value={colVal}
          setValue={setColVal}
          min={COL_MIN}
          max={COL_MAX}
          viewport={viewportCols}
          idPrefix="col"
        />
        <DimRow
          axisLabel="Max rows"
          mode={rowMode}
          setMode={setRowMode}
          value={rowVal}
          setValue={setRowVal}
          min={ROW_MIN}
          max={ROW_MAX}
          viewport={viewportRows}
          idPrefix="row"
        />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={handleApply}>Apply</button>
        </div>
      </div>
    </div>
  );
}

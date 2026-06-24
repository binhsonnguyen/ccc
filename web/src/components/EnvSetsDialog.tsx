import { useCallback, useEffect, useState } from 'react';
import {
  deleteEnvSet,
  getEnvSets,
  setEnvSecret,
  upsertEnvSet,
  type EnvSetView,
} from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  // Fired after any change is persisted so the status-bar menu can refresh.
  onChanged: () => void;
}

type VarType = 'value' | 'secret' | 'unset';

// VarRow is the editor's working copy of one var. `secretDraft` holds an
// unsaved secret value; `hasValue` reflects whether the server already stores
// one (so the input can say "stored — replace").
interface VarRow {
  key: string;
  type: VarType;
  value: string;
  secretDraft: string;
  hasValue: boolean;
}

interface Working {
  id: string;
  label: string;
  isNew: boolean;
  vars: VarRow[];
}

function viewToRows(set: EnvSetView): VarRow[] {
  return set.vars.map((v) => ({
    key: v.key,
    type: v.unset ? 'unset' : v.secret ? 'secret' : 'value',
    value: v.value ?? '',
    secretDraft: '',
    hasValue: v.hasValue,
  }));
}

// slugify makes a machine id from a label: lowercase, non-alnum → '-'.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function EnvSetsDialog({ open, onClose, onChanged }: Props) {
  const [sets, setSets] = useState<EnvSetView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (keepId?: string | null) => {
    try {
      const r = await getEnvSets();
      setSets(r.sets);
      setErr('');
      const want = keepId ?? (r.sets[0]?.id ?? null);
      const found = r.sets.find((s) => s.id === want) ?? null;
      setSelectedId(found?.id ?? null);
      setWorking(
        found
          ? { id: found.id, label: found.label, isNew: false, vars: viewToRows(found) }
          : null,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

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

  const selectSet = (id: string) => {
    const found = sets.find((s) => s.id === id);
    if (!found) return;
    setSelectedId(id);
    setWorking({ id, label: found.label, isNew: false, vars: viewToRows(found) });
    setErr('');
  };

  const newSet = () => {
    setSelectedId(null);
    setWorking({ id: '', label: '', isNew: true, vars: [] });
    setErr('');
  };

  const patchVar = (i: number, patch: Partial<VarRow>) => {
    setWorking((w) =>
      w ? { ...w, vars: w.vars.map((v, j) => (j === i ? { ...v, ...patch } : v)) } : w,
    );
  };
  const addVar = () => {
    setWorking((w) =>
      w
        ? {
            ...w,
            vars: [...w.vars, { key: '', type: 'value', value: '', secretDraft: '', hasValue: false }],
          }
        : w,
    );
  };
  const removeVar = (i: number) => {
    setWorking((w) => (w ? { ...w, vars: w.vars.filter((_, j) => j !== i) } : w));
  };

  const save = async () => {
    if (!working) return;
    const id = working.isNew ? slugify(working.id || working.label) : working.id;
    if (!id) {
      setErr('Set id/label required');
      return;
    }
    const rows = working.vars.filter((v) => v.key.trim() !== '');
    setBusy(true);
    try {
      await upsertEnvSet(id, {
        label: working.label || id,
        vars: rows.map((v) => ({
          key: v.key.trim(),
          value: v.type === 'value' ? v.value : '',
          secret: v.type === 'secret',
          unset: v.type === 'unset',
        })),
      });
      // Flush any pending secret values (must run AFTER upsert so the key is
      // declared secret server-side).
      for (const v of rows) {
        if (v.type === 'secret' && v.secretDraft !== '') {
          await setEnvSecret(id, v.key.trim(), v.secretDraft);
        }
      }
      onChanged();
      await load(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (key: string) => {
    if (!working || working.isNew) return;
    setBusy(true);
    try {
      await setEnvSecret(working.id, key, '');
      onChanged();
      await load(working.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeSet = async () => {
    if (!working || working.isNew) return;
    if (!window.confirm(`Delete env set "${working.label || working.id}"?`)) return;
    setBusy(true);
    try {
      await deleteEnvSet(working.id);
      onChanged();
      await load(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div className="modal-card envsets-dialog" role="dialog" aria-modal="true" aria-labelledby="envsets-dialog-title">
        <h2 id="envsets-dialog-title" className="modal-title">Env sets</h2>
        <p className="modal-help">
          Named bundles of environment variables injected into new sessions.
          Toggle which are active from the status-bar ⚡ menu.
        </p>

        <div className="envsets-dialog-body">
          <aside className="envsets-dialog-list">
            {sets.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`envsets-dialog-listitem${s.id === selectedId ? ' is-active' : ''}`}
                onClick={() => selectSet(s.id)}
              >
                {s.label || s.id}
              </button>
            ))}
            <button type="button" className="envsets-dialog-listitem is-new" onClick={newSet}>
              + New set
            </button>
          </aside>

          <section className="envsets-dialog-editor">
            {!working ? (
              <p className="modal-help">Select a set or create a new one.</p>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">label</span>
                  <input
                    type="text"
                    value={working.label}
                    placeholder="DeepSeek"
                    onChange={(e) => setWorking({ ...working, label: e.target.value })}
                    disabled={busy}
                  />
                </label>
                {working.isNew && (
                  <label className="field">
                    <span className="field-label">
                      id <span className="field-label-hint">(machine name)</span>
                    </span>
                    <input
                      type="text"
                      value={working.id}
                      placeholder={slugify(working.label) || 'deepseek'}
                      onChange={(e) => setWorking({ ...working, id: e.target.value })}
                      spellCheck={false}
                      disabled={busy}
                    />
                  </label>
                )}

                <div className="envsets-var-head">
                  <span>variables</span>
                  <button type="button" className="btn small" onClick={addVar} disabled={busy}>
                    + var
                  </button>
                </div>
                <div className="envsets-var-rows">
                  {working.vars.length === 0 && (
                    <p className="modal-help">No variables. Add one.</p>
                  )}
                  {working.vars.map((v, i) => (
                    <div key={i} className="envsets-var-row">
                      <input
                        className="envsets-var-key"
                        type="text"
                        value={v.key}
                        placeholder="ANTHROPIC_BASE_URL"
                        spellCheck={false}
                        onChange={(e) => patchVar(i, { key: e.target.value })}
                        disabled={busy}
                      />
                      <select
                        className="envsets-var-type"
                        value={v.type}
                        onChange={(e) => patchVar(i, { type: e.target.value as VarType })}
                        disabled={busy}
                      >
                        <option value="value">value</option>
                        <option value="secret">secret</option>
                        <option value="unset">unset</option>
                      </select>
                      {v.type === 'value' && (
                        <input
                          className="envsets-var-val"
                          type="text"
                          value={v.value}
                          placeholder="value"
                          spellCheck={false}
                          onChange={(e) => patchVar(i, { value: e.target.value })}
                          disabled={busy}
                        />
                      )}
                      {v.type === 'secret' && (
                        <input
                          className="envsets-var-val"
                          type="password"
                          value={v.secretDraft}
                          placeholder={v.hasValue ? 'stored — replace…' : 'secret value…'}
                          autoComplete="off"
                          onChange={(e) => patchVar(i, { secretDraft: e.target.value })}
                          disabled={busy}
                        />
                      )}
                      {v.type === 'unset' && (
                        <span className="envsets-var-val envsets-var-unset">removed from env</span>
                      )}
                      {v.type === 'secret' && v.hasValue && !working.isNew && (
                        <button
                          type="button"
                          className="envsets-var-clear"
                          title="Clear stored secret"
                          onClick={() => void clearSecret(v.key)}
                          disabled={busy}
                        >
                          clear
                        </button>
                      )}
                      <button
                        type="button"
                        className="envsets-var-del"
                        title="Remove variable"
                        onClick={() => removeVar(i)}
                        disabled={busy}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {err && <div className="newsession-error" role="alert">{err}</div>}

                <div className="modal-actions envsets-dialog-actions">
                  {!working.isNew && (
                    <button type="button" className="btn danger" onClick={() => void removeSet()} disabled={busy}>
                      Delete set
                    </button>
                  )}
                  <span className="envsets-dialog-spacer" />
                  <button type="button" className="btn" onClick={onClose} disabled={busy}>
                    Close
                  </button>
                  <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
                    {busy ? 'Saving…' : 'Save set'}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

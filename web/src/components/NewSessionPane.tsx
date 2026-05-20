import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, createSession, listClaudeSessions } from '../lib/api';
import { formatKeys } from '../lib/shortcuts';
import type { C3Entry, ClaudeSession } from '../types';

interface Props {
  // onCreated fires after POST /api/sessions succeeds. App pushes a tab
  // via its existing openTab path and closes this pane.
  onCreated: (entry: C3Entry) => void;
  onCancel: () => void;
  showToast: (
    msg: string,
    opts?: { variant?: 'info' | 'error' | 'warning' | 'success' },
  ) => void;
  // Bumped by App whenever the user clicks "New Claude session" while
  // this pane is already open. Used as a key on a one-shot border-pulse
  // overlay so the user sees an acknowledgement rather than a no-op.
  flashKey?: number;
}

function basename(p: string): string {
  if (!p) return '';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// crypto.randomUUID() exists in every browser we target (Chrome ≥92,
// Safari ≥15.4, Firefox ≥95). The c3 brew daemon is the only thing that
// would render this app, and Safari on the user's box is well past 15.
// Defensive fallback uses crypto.getRandomValues so an exotic browser
// without randomUUID still gets a syntactically valid v4.
function makeUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 §4.4: version 4, variant 10.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Cwd recency cache lives on listClaudeSessions in NewSessionForm; we
// keep our own tiny TTL so opening this pane after recently using the
// sidebar form doesn't double-fetch the same data.
const CACHE_TTL = 30_000;
interface CwdCache {
  at: number;
  cwds: string[];
  unbound: ClaudeSession[];
}
let cwdCache: CwdCache | null = null;

export default function NewSessionPane({ onCreated, onCancel, showToast, flashKey }: Props) {
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [firstPrompt, setFirstPrompt] = useState('');
  const [cwds, setCwds] = useState<string[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<HTMLInputElement | null>(null);

  // Auto-fill name from basename(cwd) until the user edits the field.
  useEffect(() => {
    if (!nameTouched) setName(basename(cwd));
  }, [cwd, nameTouched]);

  // Focus the prompt textarea on mount — the user's typical flow is
  // "click New → start typing immediately", so cwd defaults to the
  // most-recent value (filled below once cwds arrives) and the prompt
  // is the high-value field.
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  // Load cwd suggestions. Same shape as NewSessionForm; we don't share
  // the cache symbol because that one is module-scoped to a different
  // file and importing it across would couple two otherwise independent
  // forms.
  useEffect(() => {
    const useCache = cwdCache && Date.now() - cwdCache.at < CACHE_TTL;
    if (useCache && cwdCache) {
      setCwds(cwdCache.cwds);
      // Pre-fill cwd with the most-recent one so Cmd+Enter from a fresh
      // mount Just Works for the user's last project. They can still
      // pick a different one from the dropdown.
      if (cwdCache.cwds.length > 0 && !cwd) setCwd(cwdCache.cwds[0]);
      return;
    }
    let cancelled = false;
    listClaudeSessions()
      .then((r) => {
        if (cancelled) return;
        cwdCache = { at: Date.now(), cwds: r.cwds, unbound: r.unbound };
        setCwds(r.cwds);
        if (r.cwds.length > 0 && !cwd) setCwd(r.cwds[0]);
      })
      .catch(() => {
        if (!cancelled) setCwds([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = !!cwd.trim() && !submitting;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    const prompt = firstPrompt; // preserve newlines verbatim
    // Generate uuid client-side only when there's a prompt to auto-submit.
    // Empty prompt → leave uuid blank so the server falls back to the
    // legacy pending flow (current behavior, expected acceptance #3).
    const uuid = prompt.trim() ? makeUuidV4() : '';
    try {
      const entry = await createSession({
        cwd: cwd.trim(),
        name: name.trim(),
        firstPrompt: prompt,
        claudeUuid: uuid,
      });
      onCreated(entry);
    } catch (err) {
      if (err instanceof ApiError) {
        const m = err.body.match(/^validation failed:\s*(.+)$/);
        setError(m ? m[1] : err.body || `Create failed (HTTP ${err.status})`);
      } else {
        setError('Create failed');
      }
      showToast('Failed to start session', { variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, cwd, name, firstPrompt, onCreated, showToast]);

  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd+Enter (macOS) / Ctrl+Enter (everywhere else) submits. Plain
    // Enter inserts a newline so multi-line prompts work — the textarea
    // already has that default; we just need to NOT preventDefault on
    // bare Enter.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="newsession-pane" role="region" aria-label="New session">
      <div className="newsession-pane-inner">
        {/* One-shot pulse overlay: remounted via `key` whenever the user
          * clicks the sidebar's Claude icon while this pane is already
          * open. Skipped on initial mount (flashKey starts at 0). */}
        {flashKey ? (
          <div key={flashKey} className="form-flash-pulse" aria-hidden="true" />
        ) : null}
        <header className="newsession-pane-header">
          <h2>New session</h2>
          <p className="newsession-pane-sub">
            Pick a directory, optionally pre-fill a first prompt, then{' '}
            {formatKeys('Mod+Enter')} to start.
          </p>
        </header>

        <form
          className="newsession-pane-body"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span className="field-label">cwd</span>
            <div className="field-cwd">
              <input
                ref={cwdRef}
                type="text"
                value={cwd}
                placeholder="/absolute/path"
                onChange={(e) => {
                  setCwd(e.target.value);
                  setDropdownOpen(true);
                }}
                onFocus={() => setDropdownOpen(true)}
                onBlur={() => {
                  // delay so a click on the dropdown still fires
                  window.setTimeout(() => setDropdownOpen(false), 120);
                }}
                aria-expanded={dropdownOpen}
                aria-autocomplete="list"
                spellCheck={false}
                disabled={submitting}
              />
              {dropdownOpen && cwds.length > 0 && (
                <ul className="cwd-dropdown" role="listbox">
                  {cwds.slice(0, 30).map((c) => (
                    <li key={c}>
                      <button
                        type="button"
                        className="cwd-option"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setCwd(c);
                          setDropdownOpen(false);
                        }}
                      >
                        {c}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </label>

          <label className="field">
            <span className="field-label">name</span>
            <input
              type="text"
              value={name}
              placeholder={cwd ? basename(cwd) : 'session name'}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              spellCheck={false}
              disabled={submitting}
            />
          </label>

          <label className="field">
            <span className="field-label">
              first prompt <span className="field-label-hint">(optional)</span>
            </span>
            <textarea
              ref={promptRef}
              className="newsession-prompt"
              value={firstPrompt}
              placeholder={`Type a prompt to auto-submit, or leave empty for an interactive shell.\n\n${formatKeys('Mod+Enter')} to start, ${formatKeys('Escape')} to cancel.`}
              onChange={(e) => setFirstPrompt(e.target.value)}
              onKeyDown={onPromptKeyDown}
              rows={8}
              spellCheck={false}
              disabled={submitting}
            />
          </label>

          {error && (
            <div className="newsession-error" role="alert">
              {error}
            </div>
          )}

          <div className="newsession-pane-actions">
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={!canSubmit}
              title={formatKeys('Mod+Enter')}
            >
              {submitting ? 'Starting…' : 'Start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

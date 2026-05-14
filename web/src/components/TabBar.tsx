import type { Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeUuid: string | null;
  onSelect: (uuid: string) => void;
  onClose: (uuid: string) => void;
  onKill: (uuid: string) => void;
}

export default function TabBar({ tabs, activeUuid, onSelect, onClose, onKill }: Props) {
  if (tabs.length === 0) return <div className="tabbar empty" />;
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.claudeUuid}
          className={'tab' + (t.claudeUuid === activeUuid ? ' active' : '')}
          onClick={() => onSelect(t.claudeUuid)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(t.claudeUuid);
            }
          }}
          tabIndex={0}
          role="tab"
          aria-selected={t.claudeUuid === activeUuid}
          title={`${t.name} — ${t.cwd}`}
        >
          <span className={`tab-status status-${t.status}`} />
          <span className="tab-name">{t.name}</span>
          <button
            className="tab-kill"
            disabled={t.killing}
            onClick={(e) => {
              e.stopPropagation();
              if (t.killing) return;
              // Vanilla confirm — adequate for a local-only single-user
              // tool. Avoids pulling in a modal library for one prompt.
              if (window.confirm('Kill claude process? Scrollback will be lost.')) {
                onKill(t.claudeUuid);
              }
            }}
            title={
              t.killing
                ? 'Killing…'
                : 'Kill claude process (terminates PTY; lose scrollback)'
            }
            aria-label="Kill PTY"
          >
            {t.killing ? '…' : '⏻'}
          </button>
          <button
            className="tab-close"
            disabled={t.killing}
            onClick={(e) => {
              e.stopPropagation();
              if (t.killing) return;
              onClose(t.claudeUuid);
            }}
            title="Detach (close tab; PTY keeps running, reattach later)"
            aria-label="Detach tab"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

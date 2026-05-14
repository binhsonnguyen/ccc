import type { Tab } from '../types';

interface Props {
  tabs: Tab[];
  activeUuid: string | null;
  onSelect: (uuid: string) => void;
  onClose: (uuid: string) => void;
}

export default function TabBar({ tabs, activeUuid, onSelect, onClose }: Props) {
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
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.claudeUuid);
            }}
            title="Detach (PTY keeps running)"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

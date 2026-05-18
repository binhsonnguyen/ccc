import { formatKeys } from '../lib/shortcuts';
import { useToast } from './Toast';

interface Props {
  // Open the sidebar "New session" form. Wired from App so the card
  // doesn't need to know how the form is mounted (inline vs. drawer).
  onNewSession: () => void;
  // Open the keyboard shortcuts cheatsheet (P-2).
  onShowCheatsheet: () => void;
}

interface CardProps {
  icon: string;
  title: string;
  desc: string;
  hint?: string;
  onClick?: () => void;
  ariaLabel: string;
  disabled?: boolean;
}

function Card({ icon, title, desc, hint, onClick, ariaLabel, disabled }: CardProps) {
  return (
    <button
      type="button"
      className={'welcome-card' + (disabled ? ' welcome-card-disabled' : '')}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      <div className="welcome-card-icon" aria-hidden="true">{icon}</div>
      <div className="welcome-card-title">{title}</div>
      <p className="welcome-card-desc">{desc}</p>
      {hint && <div className="welcome-card-hint">{hint}</div>}
    </button>
  );
}

export default function Welcome({ onNewSession, onShowCheatsheet }: Props) {
  const { showToast } = useToast();
  // Resume "focuses sidebar" — we look up the first session row in the
  // DOM rather than threading a ref. The sidebar is always mounted
  // when Welcome is visible, so this is reliable.
  const focusFirstSession = () => {
    const first = document.querySelector<HTMLElement>(
      '.session-list li.session',
    );
    if (first) {
      first.focus();
    } else {
      showToast('No sessions to resume — create one with New', {
        variant: 'info',
      });
    }
  };

  return (
    <div className="welcome" role="region" aria-label="Welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <h1>ccc</h1>
          <p className="welcome-sub">claude code companion</p>
        </div>

        <div className="welcome-cards">
          <Card
            icon="⏵"
            title="Resume session"
            desc="Pick one from your sidebar."
            hint={formatKeys('Enter')}
            ariaLabel="Resume an existing session"
            onClick={focusFirstSession}
          />
          <Card
            icon="＋"
            title="New session"
            desc="Pick a directory to start claude in."
            hint={formatKeys('Mod+n')}
            ariaLabel="Create a new session"
            onClick={onNewSession}
          />
          <Card
            icon="?"
            title="Keyboard shortcuts"
            desc="See every binding."
            hint={formatKeys('Shift+?')}
            ariaLabel="View keyboard shortcuts"
            onClick={onShowCheatsheet}
          />
        </div>

        <div className="welcome-footer">
          <span>ccc</span>
          <span aria-hidden="true">·</span>
          <a
            href="https://github.com/binhsonnguyen/ccc"
            target="_blank"
            rel="noreferrer noopener"
          >
            github
          </a>
        </div>
      </div>
    </div>
  );
}

// SplitMenu: the ⊟ split affordance. Lives in the StatusBar (right edge)
// rather than the TabBar so it's reachable regardless of tab count —
// in particular when the TabBar is hidden at 1 tab, which is exactly
// when the user most wants to split. The ⊟ trigger is always visible;
// the three kind icons (✦ $_ ↪) expand on hover and are pre-expanded on
// touch (see .tabbar-split-* rules in styles.css). Disabled when the
// active tab can't be split (no active tab, or already 2 panes).

interface Props {
  // Active tab is splittable: exactly one pane and a tab is active.
  canSplit: boolean;
  onSplitActive: (kind: 'claude' | 'shell' | 'bind') => void;
}

export default function SplitMenu({ canSplit, onSplitActive }: Props) {
  const disabled = !canSplit;
  return (
    <div
      className={'tabbar-split-menu' + (disabled ? ' is-disabled' : '')}
      role="group"
      aria-label="Split active tab"
    >
      <span className="tabbar-split-trigger" aria-hidden="true">⊟</span>
      <button
        type="button"
        className="tabbar-split-kind"
        onClick={() => !disabled && onSplitActive('claude')}
        disabled={disabled}
        aria-label="Split with Claude session"
        data-tooltip="Split: new Claude session"
      >
        <span aria-hidden="true">✦</span>
      </button>
      <button
        type="button"
        className="tabbar-split-kind"
        onClick={() => !disabled && onSplitActive('shell')}
        disabled={disabled}
        aria-label="Split with shell"
        data-tooltip="Split: new shell"
      >
        <span aria-hidden="true">$_</span>
      </button>
      <button
        type="button"
        className="tabbar-split-kind"
        onClick={() => !disabled && onSplitActive('bind')}
        disabled={disabled}
        aria-label="Split with bound Claude session"
        data-tooltip="Split: adopt existing Claude session"
      >
        <span aria-hidden="true">↪</span>
      </button>
    </div>
  );
}

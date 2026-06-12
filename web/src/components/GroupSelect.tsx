import type { SidebarGroup } from '../lib/sidebarLayout';

interface Props {
  // Sidebar groups to choose from. When empty the field renders nothing —
  // a group picker with no groups would just be noise.
  groups: Pick<SidebarGroup, 'id' | 'name'>[];
  // Currently selected group id, or null for "(none)" / ungrouped.
  value: string | null;
  onChange: (groupId: string | null) => void;
  disabled?: boolean;
}

// Shared group dropdown for the two new-session forms. Presentation only —
// the owner supplies the group list + default and decides where the chosen
// group is applied. The empty option's value is "" (selects map to strings),
// translated to null on the way out.
export default function GroupSelect({ groups, value, onChange, disabled }: Props) {
  if (groups.length === 0) return null;
  return (
    <label className="field">
      <span className="field-label">group</span>
      <select
        className="field-group-select"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
      >
        <option value="">(none)</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}

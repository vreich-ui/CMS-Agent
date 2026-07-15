import { permissionMeta, toolPermissionOrder } from "../toolPermissions";
import type { ToolPermission } from "../types/workspace";

// Self-contained, theme-aware icons (stroke = currentColor), echoing the Claude permission language:
// a check for allow, a raised palm for ask/approval, a no-entry sign for block.
function PermissionIcon({ icon }: { icon: "check" | "hand" | "no-entry" }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };
  if (icon === "check") return <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>;
  if (icon === "hand") return <svg {...common}><path d="M10.05 4.58a1.58 1.58 0 1 0-3.15 0v3m3.15-3v-1.5a1.58 1.58 0 0 1 3.15 0v1.5m-3.15 0 .08 5.92m3.07.75V4.58m0 0a1.58 1.58 0 0 1 3.15 0V15M6.9 7.58a1.58 1.58 0 1 0-3.15 0v8.17a6.75 6.75 0 0 0 6.75 6.75h2a5.25 5.25 0 0 0 3.71-1.54l1.73-1.73a5.25 5.25 0 0 0 1.54-3.71v-2.02a.67.67 0 0 1 .2-.47 1.58 1.58 0 1 0-2.23-2.23 3.82 3.82 0 0 0-1.12 2.69" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M5.64 5.64 18.36 18.36" /></svg>;
}

type Props = {
  value: ToolPermission;
  onChange: (permission: ToolPermission) => void;
  disabled?: boolean;
  idBase: string;
};

// Three-state segmented control (allow / ask / block). Rendered as a radiogroup so keyboard and
// screen-reader users get the same three-way choice the icons express visually.
export function PermissionToggle({ value, onChange, disabled, idBase }: Props) {
  return <div className="permission-toggle" role="radiogroup" aria-label="Tool permission">
    {toolPermissionOrder.map((permission) => {
      const meta = permissionMeta[permission];
      const selected = value === permission;
      return <button
        key={permission}
        type="button"
        role="radio"
        aria-checked={selected}
        id={`${idBase}-${permission}`}
        className={`permission-option permission-option--${meta.tone}${selected ? " is-selected" : ""}`}
        title={meta.hint}
        disabled={disabled}
        onClick={() => { if (!selected) onChange(permission); }}
      >
        <PermissionIcon icon={meta.icon} />
        <span>{meta.short}</span>
      </button>;
    })}
  </div>;
}

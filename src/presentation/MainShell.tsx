import type { ReactNode } from "react";

interface MainShellProps {
  children: ReactNode;
}

interface ShellUtilitiesProps {
  searchLabel: string;
  settingsLabel: string;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
}

export function MainShell({
  children,
}: MainShellProps) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div data-shell-screen className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {children}
      </div>
    </main>
  );
}

export function ShellUtilities({
  searchLabel,
  settingsLabel,
  onOpenSearch,
  onOpenSettings,
}: ShellUtilitiesProps) {
  return (
    <div
      data-shell-utilities
      className="ml-0.5 flex shrink-0 items-center gap-1 border-l pl-1.5"
      style={{ borderLeftWidth: "0.5px", borderColor: "var(--hairline)" }}
    >
      <UtilityButton label={searchLabel} onClick={onOpenSearch}>
        <SearchIcon />
      </UtilityButton>
      <UtilityButton label={settingsLabel} onClick={onOpenSettings}>
        <SettingsIcon />
      </UtilityButton>
    </div>
  );
}

function UtilityButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="interactive-control flex h-8 w-8 items-center justify-center rounded-md"
      style={{ color: "var(--slate)" }}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10 10 3 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <path
        d="M7.1 2.25h1.8l.34 1.42c.3.11.57.27.83.47l1.4-.43.9 1.56-1.06 1a4.1 4.1 0 0 1 0 .96l1.06 1-.9 1.56-1.4-.43c-.26.2-.53.36-.83.47l-.34 1.42H7.1l-.34-1.42a3.66 3.66 0 0 1-.83-.47l-1.4.43-.9-1.56 1.06-1a4.1 4.1 0 0 1 0-.96l-1.06-1 .9-1.56 1.4.43c.26-.2.53-.36.83-.47l.34-1.42Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.15"
      />
      <circle cx="8" cy="7.75" r="1.55" fill="none" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

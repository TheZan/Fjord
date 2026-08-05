// Shared visual primitives. Every control in the app goes through these so
// sizing, radii and hairline weights stay consistent — previously each
// button carried its own inline `borderColor/background/color` triple, which
// is how the same nominal control ended up rendering at three different
// heights on one screen.
//
// Tokens come from src/index.css (docs/specs/theming.md); nothing here
// hardcodes a color.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_HEIGHT: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-[13px]",
};

function buttonStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: "var(--fjord-tint)",
        borderColor: "var(--fjord)",
        color: "var(--fjord-ink)",
      };
    case "danger":
      return {
        background: "transparent",
        borderColor: "var(--hairline)",
        color: "var(--rust-ink)",
      };
    case "ghost":
      return { background: "transparent", borderColor: "transparent", color: "var(--slate)" };
    default:
      return {
        background: "var(--paper)",
        borderColor: "var(--hairline-strong)",
        color: "var(--ink)",
      };
  }
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-45 ${BUTTON_HEIGHT[size]} ${className}`}
      style={{ borderWidth: "0.5px", ...buttonStyle(variant), ...style }}
    />
  );
}

export function Input({ className = "", style, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-8 rounded-md border px-2.5 text-[13px] outline-none placeholder:text-[var(--mist)] focus:border-[var(--fjord)] ${className}`}
      style={{
        borderWidth: "0.5px",
        borderColor: "var(--hairline-strong)",
        background: "var(--page-bg)",
        color: "var(--ink)",
        ...style,
      }}
    />
  );
}

export function Card({
  children,
  className = "",
  selected = false,
  style,
}: {
  children: ReactNode;
  className?: string;
  selected?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-xl border ${className}`}
      style={{
        borderWidth: "0.5px",
        borderColor: selected ? "var(--fjord)" : "var(--hairline)",
        background: "var(--paper)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Small uppercase label that heads a group. Never larger than the content it labels. */
export function GroupLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`text-[10px] font-medium uppercase tracking-[0.08em] ${className}`}
      style={{ color: "var(--mist)" }}
    >
      {children}
    </span>
  );
}

type Tone = "neutral" | "fjord" | "moss" | "amber" | "rust";

const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  neutral: { background: "var(--page-bg)", color: "var(--slate)" },
  fjord: { background: "var(--fjord-tint)", color: "var(--fjord-ink)" },
  moss: { background: "var(--moss-tint)", color: "var(--moss-ink)" },
  amber: { background: "var(--amber-tint)", color: "var(--amber-ink)" },
  rust: { background: "var(--rust-tint)", color: "var(--rust-ink)" },
};

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={TONE_STYLE[tone]}
    >
      {children}
    </span>
  );
}

export function Muted({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={className} style={{ color: "var(--slate)" }}>
      {children}
    </span>
  );
}

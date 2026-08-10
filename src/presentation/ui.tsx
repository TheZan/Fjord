// Shared visual primitives. Every control in the app goes through these so
// sizing, radii and hairline weights stay consistent — previously each
// button carried its own inline `borderColor/background/color` triple, which
// is how the same nominal control ended up rendering at three different
// heights on one screen.
//
// Tokens come from src/index.css (docs/specs/theming.md); nothing here
// hardcodes a color.

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { createContext, forwardRef, useContext, useEffect } from "react";

/**
 * Shell typography scale. These four steps cover screen identity, ordinary
 * controls/content, supporting metadata, and compact uppercase labels.
 * Components should consume these tokens instead of inventing nearby pixel
 * sizes, keeping density consistent across the sidebar and main screens.
 */
export const TYPOGRAPHY = {
  screenTitle: "text-[17px] font-medium",
  body: "text-[13px]",
  caption: "text-[11px]",
  microLabel: "text-[10px] font-medium uppercase tracking-[0.08em]",
} as const;

const SurfaceDepth = createContext(0);

/**
 * A visual grouping surface. A nested surface deliberately drops its full
 * border, so cards and panels can be composed without producing card-in-card
 * chrome. Hairline separators inside a surface remain available to its owner.
 */
export const Surface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { bordered?: boolean }
>(function Surface({ bordered = true, className = "", style, children, ...props }, ref) {
  const depth = useContext(SurfaceDepth);
  const drawsBorder = bordered && depth === 0;
  return (
    <SurfaceDepth.Provider value={depth + 1}>
      <div
        ref={ref}
        {...props}
        data-ui-surface=""
        data-border-level={drawsBorder ? "1" : "0"}
        className={`rounded-lg ${drawsBorder ? "border" : ""} ${className}`}
        style={{
          borderWidth: drawsBorder ? "0.5px" : undefined,
          borderColor: drawsBorder ? "var(--hairline)" : undefined,
          ...style,
        }}
      >
        {children}
      </div>
    </SurfaceDepth.Provider>
  );
});

export function ScreenSurface({
  screen,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "data-screen"> & { screen: "overview" | "repository" }) {
  return <Surface {...props} bordered={false} data-screen={screen} />;
}

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
      data-variant={variant}
      className={`interactive-control inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors disabled:opacity-45 ${BUTTON_HEIGHT[size]} ${className}`}
      style={{ borderWidth: "0.5px", ...buttonStyle(variant), ...style }}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", style, ...props }, ref) {
    return (
      <input
        ref={ref}
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
  },
);

export function Select({ className = "", style, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`interactive-control h-8 rounded-md border px-2.5 text-[13px] outline-none focus:border-[var(--fjord)] disabled:opacity-45 ${className}`}
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

export function Textarea({
  className = "",
  style,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`resize-none rounded-md border px-2.5 py-1.5 text-[13px] outline-none placeholder:text-[var(--mist)] focus:border-[var(--fjord)] ${className}`}
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
  style?: CSSProperties;
}) {
  return (
    <Surface
      className={className}
      style={{
        background: "var(--paper)",
        outline: selected ? "1px solid var(--fjord)" : undefined,
        outlineOffset: selected ? "-1px" : undefined,
        ...style,
      }}
    >
      {children}
    </Surface>
  );
}

/** Small uppercase label that heads a group. Never larger than the content it labels. */
export function GroupLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`${TYPOGRAPHY.microLabel} ${className}`}
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

export function NotificationToast({
  message,
  tone,
  closeLabel,
  onClose,
}: {
  message: string;
  tone: "success" | "error";
  closeLabel: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(onClose, tone === "error" ? 7000 : 4000);
    return () => window.clearTimeout(timeout);
  }, [onClose, tone]);

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className="desktop-popover fixed bottom-4 right-4 z-[70] flex max-w-[min(28rem,calc(100vw-2rem))] items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
      style={{
        background: "var(--paper)",
        borderColor: tone === "error" ? "var(--rust)" : "var(--moss)",
        color: tone === "error" ? "var(--rust-ink)" : "var(--moss-ink)",
      }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
        style={{ background: tone === "error" ? "var(--rust-tint)" : "var(--moss-tint)" }}
      >
        {tone === "error" ? "!" : "✓"}
      </span>
      <span className="selectable-text min-w-0 flex-1 whitespace-pre-wrap">{message}</span>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        className="interactive-control flex h-5 w-5 shrink-0 items-center justify-center rounded text-base leading-none"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

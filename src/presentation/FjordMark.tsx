// The "Cleft" mark — see assets/logo/README.md for the geometry spec and
// color rules. Inline SVG (not an <img>) so it inherits color via
// `currentColor`, per the mark's own usage instructions.

import type { CSSProperties } from "react";

interface FjordMarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function FjordMark({ size = 28, className, style }: FjordMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label="Fjord"
      className={className}
      style={style}
    >
      <path d="M20 16 H60 L46 112 H20 Z" fill="currentColor" />
      <path d="M68 16 H108 V112 H82 Z" fill="currentColor" />
    </svg>
  );
}

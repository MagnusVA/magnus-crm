import type { CSSProperties } from "react";

/**
 * Theme-aware dot-grid background.
 *
 * Uses the `--dot-grid` CSS variable defined in globals.css so the dots
 * are visible in both light and dark modes. Spread onto any container
 * that needs the subtle grid texture.
 *
 * @example
 * <div style={DOT_GRID_STYLE} className="bg-background">...</div>
 */
export const DOT_GRID_STYLE: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle, var(--dot-grid) 1px, transparent 1px)",
  backgroundSize: "24px 24px",
};

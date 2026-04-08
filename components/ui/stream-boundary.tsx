"use client";

import { type ReactNode, Suspense } from "react";

interface StreamBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Suspense boundary that adds an entrance animation when content resolves.
 * Wraps the resolved content in an `animate-stream-in` container that
 * fades in and slides up over 300ms (see globals.css).
 *
 * When used inside a grid or flex parent, pass `className="contents"`
 * to make the wrapper invisible to CSS layout.
 *
 * The animation is disabled automatically when the user has
 * `prefers-reduced-motion: reduce` enabled (WCAG 2.1 AA, SC 2.3.3).
 *
 * If View Transitions already provide sufficient visual continuity for
 * Suspense reveals, this component may be unnecessary — test both.
 *
 * @see vercel-react-view-transitions — Suspense reveal animations
 * @see web-design-guidelines — prefers-reduced-motion accessibility
 */
export function StreamBoundary({ fallback, children, className }: StreamBoundaryProps) {
  return (
    <Suspense fallback={fallback}>
      <div className={`animate-stream-in ${className ?? ""}`}>
        {children}
      </div>
    </Suspense>
  );
}

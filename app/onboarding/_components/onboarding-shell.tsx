"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { DOT_GRID_STYLE } from "@/lib/dot-grid";

/**
 * Shared centered layout for onboarding pages.
 *
 * Renders a full-viewport canvas with a subtle dot-grid background,
 * a compact wordmark header, and a centered content slot.
 */
export function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative flex min-h-screen w-full flex-col items-center bg-background"
      style={DOT_GRID_STYLE}
    >
      {/* Wordmark */}
      <header className="flex w-full items-center justify-between px-6 pt-6">
        <Link
          href="/"
          className="inline-block text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Magnus
        </Link>
        <ThemeToggle />
      </header>

      {/* Centered content */}
      <main className="flex w-full flex-1 flex-col items-center justify-center px-4 py-12">
        {children}
      </main>

      {/* Footer */}
      <footer className="w-full px-6 pb-6">
        <p className="text-[11px] text-muted-foreground/60">
          Tenant onboarding &middot; Secured by WorkOS
        </p>
      </footer>
    </div>
  );
}

/**
 * Three-dot pulse animation for loading states.
 * Uses CSS-only animation, respects prefers-reduced-motion.
 */
export function PulsingDots() {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

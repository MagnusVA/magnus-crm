import { ViewTransition, type ReactNode } from "react";

// View transitions for workspace pages. The CSS classes live in
// app/globals.css. All of them stay off for prefers-reduced-motion.

/** Transition type for navigations from the sidebar and the command palette. */
export const WORKSPACE_NAV = ["workspace-nav"];

/** The page area cross-fades on a `WORKSPACE_NAV` navigation, and on nothing else. */
export function PageAreaTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition update={{ "workspace-nav": "page-transition", default: "none" }} default="none">
      {children}
    </ViewTransition>
  );
}

/** Wrap a loading.tsx skeleton: it slides down and fades out as the page arrives. */
export function SkeletonExit({ children }: { children: ReactNode }) {
  return (
    <ViewTransition exit="slide-down" default="none">
      {children}
    </ViewTransition>
  );
}

/** Wrap a page that streams in behind loading.tsx: it slides up and fades in. */
export function ContentReveal({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="slide-up" default="none">
      {children}
    </ViewTransition>
  );
}

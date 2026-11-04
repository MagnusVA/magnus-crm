"use client";

import { Component, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { reviewCounts, type ReviewCounts } from "./review-data";

// The open Review count, for the band (figures and the tab) and the sidebar.
// They all read api.team.review.listReviewItems with the same arguments, so
// Convex keeps one subscription for them and the Review page.

/** The open items by kind; undefined while loading. Throws if the review can't be read. */
export function useReviewCounts(): ReviewCounts | undefined {
  const review = useQuery(api.team.review.listReviewItems, {});
  return review ? reviewCounts(review.items) : undefined;
}

/**
 * Renders nothing if its children throw: a count is a hint, and the band or
 * the sidebar must not fail with it (a tenant too large to review throws).
 */
export class QuietBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** Team › Review in the sidebar: the open count as an amber badge, above 0 only. */
export function ReviewNavBadge() {
  return (
    <QuietBoundary>
      <NavCount />
    </QuietBoundary>
  );
}

function NavCount() {
  const total = useReviewCounts()?.total ?? 0;
  if (total <= 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning px-1.5 font-condensed text-xs font-bold tabular-nums text-primary-foreground"
      aria-label={`${total} to decide`}
    >
      {total >= 100 ? "99+" : total}
    </span>
  );
}

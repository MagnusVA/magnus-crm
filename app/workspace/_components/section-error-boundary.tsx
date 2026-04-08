"use client";

import { Component, type ReactNode } from "react";
import { AlertCircleIcon } from "lucide-react";

interface SectionErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  sectionName?: string;
}

interface SectionErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Per-section error boundary for granular error isolation.
 *
 * Wraps each `<Suspense>` boundary so a failing section (e.g. a
 * `preloadQuery` rejection) does not take down the entire dashboard.
 * Other sections continue to render normally.
 */
export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  constructor(props: SectionErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          role="alert"
          aria-live="assertive"
        >
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-destructive">
              Failed to load {this.props.sectionName ?? "this section"}
            </p>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

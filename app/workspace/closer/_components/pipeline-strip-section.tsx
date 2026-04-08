"use client";

import { usePreloadedQuery } from "convex/react";
import type { Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";
import { PipelineStrip } from "./pipeline-strip";

/**
 * Client component that renders the pipeline status strip.
 * Receives preloaded data from the parent server page.
 */
export function PipelineStripSection({
  preloadedPipelineSummary,
}: {
  preloadedPipelineSummary: Preloaded<typeof api.closer.dashboard.getPipelineSummary>;
}) {
  const summary = usePreloadedQuery(preloadedPipelineSummary);

  if (!summary) return null;

  return (
    <PipelineStrip
      counts={summary.counts}
      total={summary.total}
    />
  );
}

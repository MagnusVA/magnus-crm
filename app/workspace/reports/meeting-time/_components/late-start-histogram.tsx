import type { HistogramCounts } from "./meeting-time-report-helpers";
import { MeetingTimeHistogramCard } from "./meeting-time-histogram-card";

interface LateStartHistogramProps {
  buckets: HistogramCounts;
}

export function LateStartHistogram({ buckets }: LateStartHistogramProps) {
  return (
    <MeetingTimeHistogramCard
      title="Late-Start Histogram"
      description="Buckets of observed late starts, measured in whole minutes."
      ariaLabel="Late-start histogram with minute buckets"
      emptyTitle="No late-start distribution yet"
      emptyDescription="Started meetings in this range have not produced measurable start timing data."
      color="var(--chart-2)"
      buckets={buckets}
    />
  );
}

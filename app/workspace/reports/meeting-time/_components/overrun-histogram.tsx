import type { HistogramCounts } from "./meeting-time-report-helpers";
import { MeetingTimeHistogramCard } from "./meeting-time-histogram-card";

interface OverrunHistogramProps {
  buckets: HistogramCounts;
}

export function OverrunHistogram({ buckets }: OverrunHistogramProps) {
  return (
    <MeetingTimeHistogramCard
      title="Overrun Histogram"
      description="How far meetings exceeded their scheduled duration, in whole minutes."
      ariaLabel="Overrun histogram with minute buckets"
      emptyTitle="No overrun distribution yet"
      emptyDescription="Completed meetings in this range have not produced measurable stop timing data."
      color="var(--chart-4)"
      buckets={buckets}
    />
  );
}

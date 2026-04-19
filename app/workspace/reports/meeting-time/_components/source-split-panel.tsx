import type {
  NoShowSourceCounts,
  StartedAtSourceCounts,
  StoppedAtSourceCounts,
} from "./meeting-time-report-helpers";
import { SourceSplitChart } from "./source-split-chart";

interface SourceSplitPanelProps {
  startedAtSource: StartedAtSourceCounts;
  stoppedAtSource: StoppedAtSourceCounts;
  noShowSource: NoShowSourceCounts;
}

export function SourceSplitPanel({
  startedAtSource,
  stoppedAtSource,
  noShowSource,
}: SourceSplitPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <SourceSplitChart
        title="Start Source"
        description="Who supplied the meeting start timestamp."
        ariaLabel="Start source distribution"
        counts={startedAtSource}
        labels={{
          closer: "Closer",
          admin_manual: "Admin manual",
          none: "None recorded",
        }}
        colors={{
          closer: "var(--chart-1)",
          admin_manual: "var(--chart-3)",
          none: "var(--muted-foreground)",
        }}
        emptyTitle="No start-source data"
        emptyDescription="No meetings with a scheduled timestamp matched this range."
      />

      <SourceSplitChart
        title="Stop Source"
        description="How the stop timestamp was set for each meeting."
        ariaLabel="Stop source distribution"
        counts={stoppedAtSource}
        labels={{
          closer: "Closer",
          closer_no_show: "Closer no-show",
          admin_manual: "Admin manual",
          system: "System",
          none: "None recorded",
        }}
        colors={{
          closer: "var(--chart-1)",
          closer_no_show: "var(--chart-2)",
          admin_manual: "var(--chart-3)",
          system: "var(--chart-4)",
          none: "var(--muted-foreground)",
        }}
        emptyTitle="No stop-source data"
        emptyDescription="No meetings with scheduled timestamps matched this range."
      />

      <SourceSplitChart
        title="No-Show Source"
        description="Includes non-no-show meetings in the “None recorded” bucket."
        ariaLabel="No-show source distribution"
        counts={noShowSource}
        labels={{
          closer: "Closer",
          calendly_webhook: "Calendly webhook",
          none: "None recorded",
        }}
        colors={{
          closer: "var(--chart-2)",
          calendly_webhook: "var(--chart-4)",
          none: "var(--muted-foreground)",
        }}
        emptyTitle="No no-show source data"
        emptyDescription="No meetings with scheduled timestamps matched this range."
      />
    </div>
  );
}

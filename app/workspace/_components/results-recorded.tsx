export const SHOW_RATE_HELP =
  "Held calls ÷ (held + no-show). Canceled and not-recorded calls are left out.";

export const ATTENDANCE_COUNTS_PARTIAL_HELP =
  "Too many calls in the last day to check every end time; the count is a lower bound.";

export function ResultsRecorded({
  resultsRecorded,
  pastCalls,
  attendanceCountsPartial,
}: {
  resultsRecorded: number;
  pastCalls: number;
  attendanceCountsPartial?: boolean;
}) {
  return (
    <p
      className="mt-1 text-xs font-normal text-muted-foreground"
      title={attendanceCountsPartial ? ATTENDANCE_COUNTS_PARTIAL_HELP : undefined}
    >
      {resultsRecorded.toLocaleString()} of {pastCalls.toLocaleString()} past
      calls have a result{attendanceCountsPartial ? " (partial)" : ""}
    </p>
  );
}

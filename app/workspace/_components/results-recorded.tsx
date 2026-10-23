export const SHOW_RATE_HELP =
  "Held calls ÷ (held + no-show). Canceled and not-recorded calls are left out.";

export function ResultsRecorded({
  resultsRecorded,
  pastCalls,
}: {
  resultsRecorded: number;
  pastCalls: number;
}) {
  return (
    <p className="mt-1 text-xs font-normal text-muted-foreground">
      {resultsRecorded.toLocaleString()} of {pastCalls.toLocaleString()} past
      calls have a result
    </p>
  );
}

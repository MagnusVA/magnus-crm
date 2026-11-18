import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import { SETTINGS_ROOT } from "@/app/workspace/settings/_components/settings-ui";
import { AutomaticResultsBand } from "./automatic-results-band";

/** The page's frame while it loads: the band, the switches, the grader and the scorecard. */
export function AutomaticResultsSkeleton() {
  return (
    <div className={SETTINGS_ROOT} role="status" aria-label="Loading automatic results">
      <AutomaticResultsBand />
      <IntegrationCardSkeleton label="Loading the switches" groups={[2, 3, 3]} />
      <IntegrationCardSkeleton label="Loading the grader" groups={[1]} />
      <IntegrationCardSkeleton label="Loading the scorecard" groups={[3, 4]} />
    </div>
  );
}

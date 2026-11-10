import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import { SETTINGS_ROOT } from "@/app/workspace/settings/_components/settings-ui";
import { FathomPageBand } from "./fathom-page-band";

/** The Fathom page's frame while its settings load: the band, members on the left, the connection on the right. */
export function FathomPageSkeleton() {
  return (
    <div className={SETTINGS_ROOT} role="status" aria-label="Loading Fathom settings">
      <FathomPageBand />
      <div className="grid gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] @4xl:items-start">
        <IntegrationCardSkeleton label="Loading Fathom members" groups={[6]} />
        <IntegrationCardSkeleton label="Loading Fathom connection" groups={[3]} />
      </div>
    </div>
  );
}

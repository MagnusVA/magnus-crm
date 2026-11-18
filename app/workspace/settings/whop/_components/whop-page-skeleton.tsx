import { IntegrationCardSkeleton } from "@/app/workspace/settings/_components/settings-skeleton";
import { SETTINGS_ROOT } from "@/app/workspace/settings/_components/settings-ui";
import { WhopPageBand } from "./whop-page-band";

/** The Whop page's frame while it loads: the band, products and prices on the left, the webhook and connection on the right. */
export function WhopPageSkeleton() {
  return (
    <div className={SETTINGS_ROOT} role="status" aria-label="Loading Whop settings">
      <WhopPageBand />
      <div className="grid gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] @4xl:items-start">
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-2 @4xl:row-start-1">
          <IntegrationCardSkeleton label="Loading Whop webhook" groups={[3]} />
          <IntegrationCardSkeleton label="Loading Whop connection" groups={[3, 3]} />
        </div>
        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-1">
          <IntegrationCardSkeleton label="Loading Whop products and prices" groups={[6]} />
        </div>
      </div>
    </div>
  );
}

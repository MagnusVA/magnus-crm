import { PageBand } from "@/app/workspace/_components/page-band";
import { cn } from "@/lib/utils";
import { DmClosersCardSkeleton, DmTeamsCardSkeleton } from "./attribution-registry-skeleton";
import {
  ATTRIBUTION_BACK,
  ATTRIBUTION_DESCRIPTION,
  ATTRIBUTION_ROOT,
  ATTRIBUTION_TITLE,
  BAND_TAB_LIST,
  BAND_TAB_ROW,
  SECTION_LABEL,
  SECTIONS,
} from "./attribution-layout";

/** The page before the client loads: the real band, then the Teams section's cards. */
export function AttributionPageSkeleton() {
  return (
    <div className={ATTRIBUTION_ROOT}>
      <PageBand title={ATTRIBUTION_TITLE} description={ATTRIBUTION_DESCRIPTION} back={ATTRIBUTION_BACK}>
        <div className={BAND_TAB_ROW}>
          <div aria-hidden="true" className={BAND_TAB_LIST}>
            {SECTIONS.map((section, index) => (
              <span
                key={section}
                className={cn(
                  "flex h-10 shrink-0 items-center border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase",
                  index === 0 ? "border-primary text-board-foreground" : "border-transparent text-board-muted",
                )}
              >
                {SECTION_LABEL[section]}
              </span>
            ))}
          </div>
        </div>
      </PageBand>
      <div className="grid gap-3.5 short:gap-3 @6xl:grid-cols-[0.9fr_1.1fr] @6xl:items-start">
        <DmTeamsCardSkeleton />
        <DmClosersCardSkeleton />
      </div>
    </div>
  );
}

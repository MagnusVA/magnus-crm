import { Skeleton } from "@/components/ui/skeleton";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";

// The band's figure row, in the Sales calls band's grammar (11px condensed
// labels, 30px condensed figures, 13px proof lines): how many deals a missed
// meeting closed in the range, by kind, and how many of those people booked
// again.

const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const PROOF = "text-[13px] text-board-foreground/75";

export type MissedCounts = {
  total: number;
  noShows: number;
  canceled: number;
  bookedAgain: number;
};

function Zone({ label, tip, children }: { label: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
      <p className={LABEL}>
        <HelpTip tip={tip}>{label}</HelpTip>
      </p>
      {children}
    </div>
  );
}

function Pending() {
  return (
    <>
      <Skeleton className="h-8 w-16 bg-board-raised" />
      <Skeleton className="h-3.5 w-32 max-w-full bg-board-raised" />
    </>
  );
}

function share(part: number, total: number) {
  return total === 0 ? null : `${Math.round((part / total) * 100)}% of missed`;
}

export function MissedFigures({
  counts,
  partial,
  hideBookedAgain,
}: {
  /** Undefined before the first rows arrive. */
  counts: MissedCounts | undefined;
  /** The range holds more deals than the page reads, so the figures are lower bounds. */
  partial: boolean;
  hideBookedAgain: boolean;
}) {
  const plus = partial ? "+" : "";
  return (
    <div
      role="group"
      aria-label="Missed meeting figures"
      className="-mx-4 grid grid-cols-2 gap-px border-t border-board-line bg-board-line @lg:-mx-[18px] @3xl:grid-cols-4"
    >
      <Zone label="Missed" tip="Deals a no-show or a cancellation closed in this range, by when the deal closed.">
        {counts ? (
          <>
            <p className={FIGURE}>
              {formatWholeNumber(counts.total)}
              {plus}
            </p>
            <p className={PROOF}>
              {counts.total === 0
                ? "No deals closed on a missed call"
                : `${formatWholeNumber(counts.noShows)} no-show${counts.noShows === 1 ? "" : "s"} · ${formatWholeNumber(counts.canceled)} canceled`}
            </p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="No-shows" tip="The person didn't join the call, and the deal closed lost on it.">
        {counts ? (
          <>
            <p className={FIGURE}>
              {formatWholeNumber(counts.noShows)}
              {plus}
            </p>
            <p className={PROOF}>{share(counts.noShows, counts.total) ?? "None in this range"}</p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="Canceled" tip="The person canceled the call, and the deal closed lost on it.">
        {counts ? (
          <>
            <p className={FIGURE}>
              {formatWholeNumber(counts.canceled)}
              {plus}
            </p>
            <p className={PROOF}>{share(counts.canceled, counts.total) ?? "None in this range"}</p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone
        label="Booked again"
        tip="People with a newer deal that has a booking. They already came back, so outreach can skip them."
      >
        {counts ? (
          hideBookedAgain ? (
            <>
              <p className="flex min-h-[31.5px] items-center text-[15px] font-medium text-board-muted">Hidden</p>
              <p className={PROOF}>Not in the list or the export</p>
            </>
          ) : (
            <>
              <p className={FIGURE}>
                {formatWholeNumber(counts.bookedAgain)}
                {plus}
              </p>
              <p className={PROOF}>
                {counts.total === 0
                  ? "Nobody to count yet"
                  : `${formatWholeNumber(counts.bookedAgain)} of ${formatWholeNumber(counts.total)} have a new booking`}
              </p>
            </>
          )
        ) : (
          <Pending />
        )}
      </Zone>
    </div>
  );
}

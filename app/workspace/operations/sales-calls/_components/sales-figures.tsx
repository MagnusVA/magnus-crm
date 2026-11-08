import { Fragment } from "react";
import { TextPlaceholder } from "@/app/workspace/_components/text-placeholder";
import { formatCash } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";
import { dealsWonWords, formatCloseRate } from "./close-rate";
import type { SalesCallsStats, SalesSummaryMoney } from "./sales-calls-data";
import { formatCount, formatRateOrDash, resultsTitle, resultsWords } from "./sales-format";

// The band's figure row: the page's five headline figures on the navy band,
// in the book panel's grammar (11px condensed labels, 30px condensed
// figures, 13px proof lines). Money keeps each currency's own sum, the main
// currency first (DESIGN.md, The Separate Currencies Rule).

const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const OTHER = "font-condensed text-[17px] font-semibold tabular-nums text-board-foreground";
const PROOF = "text-[13px] text-board-foreground/75";

function Zone({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5", className)}>
      <p className={LABEL}>{label}</p>
      {children}
    </div>
  );
}

/** Placeholders in the loaded lines' own type, so a zone keeps its height when the figures arrive. */
function Pending() {
  return (
    <>
      <p className={FIGURE}>
        <TextPlaceholder sample="000" />
      </p>
      <p className={PROOF}>
        <TextPlaceholder sample="0 canceled · 0 no-show" />
      </p>
    </>
  );
}

function salesWords(count: number) {
  return `${formatCount(count)} payment sale${count === 1 ? "" : "s"}`;
}

/** Each other currency's figure at 17px beside the main one. */
function OtherCurrencies({ entries }: { entries: Array<{ currency: string; text: string }> }) {
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.currency}>
          {" "}
          <span className={OTHER}>{entry.text}</span>
        </Fragment>
      ))}
    </>
  );
}

export function SalesFigures({
  stats,
  mainCurrency,
  attendanceCountsPartial,
}: {
  stats: SalesCallsStats | undefined;
  mainCurrency: string;
  attendanceCountsPartial?: boolean;
}) {
  const money = stats?.moneyByCurrency ?? [];
  const main: SalesSummaryMoney = money.find((entry) => entry.currency.toUpperCase() === mainCurrency) ?? {
    currency: mainCurrency,
    paymentSalesCount: 0,
    cashCollectedMinor: 0,
    avgCashPerSaleMinor: null,
  };
  const others = money.filter(
    (entry) => entry.currency.toUpperCase() !== mainCurrency && (entry.paymentSalesCount > 0 || entry.cashCollectedMinor !== 0),
  );
  const wonWords = stats ? dealsWonWords(stats) : null;

  return (
    <div
      aria-label="Headline figures"
      role="group"
      className="-mx-4 grid grid-cols-2 gap-px border-t border-board-line bg-board-line @lg:-mx-[18px] @3xl:grid-cols-3 @5xl:grid-cols-5"
    >
      <Zone label="Calls">
        {stats ? (
          <>
            <p className={FIGURE}>{formatCount(stats.totalCalls)}</p>
            <p className={PROOF}>
              {formatCount(stats.canceled)} canceled · {formatCount(stats.noShows)} no-show
            </p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="Show rate">
        {stats ? (
          <>
            <p className={FIGURE}>{formatRateOrDash(stats.showUpRate)}</p>
            <p className={PROOF} title={resultsTitle(attendanceCountsPartial)}>
              {resultsWords(stats, attendanceCountsPartial)}
            </p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="Cash collected">
        {stats ? (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 leading-[1.05]">
              <span className={cn(FIGURE, "text-primary")}>{formatCash(main.cashCollectedMinor, main.currency)}</span>
              <OtherCurrencies
                entries={others.map((entry) => ({ currency: entry.currency, text: formatCash(entry.cashCollectedMinor, entry.currency) }))}
              />
            </p>
            <p className={PROOF}>
              {main.paymentSalesCount > 0 || others.length > 0 ? salesWords(main.paymentSalesCount) : "No payments yet"}
              {others.length > 0
                ? ` in ${main.currency} · ${others.map((entry) => `${formatCount(entry.paymentSalesCount)} in ${entry.currency}`).join(" · ")}`
                : null}
            </p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="Close rate">
        {stats ? (
          <>
            <p className={FIGURE}>{formatCloseRate(stats)}</p>
            <p className={PROOF}>{wonWords ?? "Counted from deals' first held calls"}</p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
      <Zone label="Average sale" className="col-span-2 @3xl:col-span-2 @5xl:col-span-1">
        {stats ? (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 leading-[1.05]">
              <span className={FIGURE}>
                {main.avgCashPerSaleMinor === null ? "—" : formatCash(Math.round(main.avgCashPerSaleMinor), main.currency)}
              </span>
              <OtherCurrencies
                entries={others
                  .filter((entry) => entry.avgCashPerSaleMinor !== null)
                  .map((entry) => ({
                    currency: entry.currency,
                    text: formatCash(Math.round(entry.avgCashPerSaleMinor ?? 0), entry.currency),
                  }))}
              />
            </p>
            <p className={PROOF}>
              {main.paymentSalesCount > 0
                ? `${formatCash(main.cashCollectedMinor, main.currency)} ÷ ${salesWords(main.paymentSalesCount)}`
                : "No payment sales to average"}
            </p>
          </>
        ) : (
          <Pending />
        )}
      </Zone>
    </div>
  );
}

import { amountIn, formatCash, type CurrencyAmount, type PipelineMonth } from "@/lib/closer-pipeline";
import { cn } from "@/lib/utils";

export type MoneyStripProps = {
  month: PipelineMonth;
  currency: string;
  cash: { currencies: CurrencyAmount[]; paymentCount: number; isPartial: boolean };
  /** The previous period's cash, or undefined while it loads. */
  previous: { currencies: CurrencyAmount[] } | undefined;
  wins: { won: number; decided: number; isPartial: boolean };
  open: { count: number; withoutNextStep: number; isPartial: boolean };
  /** The programs with a section, in section order; "No program" isn't one. */
  programs: string[];
};

/**
 * The month on one navy strip: cash collected in the main currency (lime),
 * the other currencies beside it, the change against last month and the
 * payment count; won of decided; open deals with how many have no next step;
 * and the programs on the page.
 */
export function MoneyStrip({ month, currency, cash, previous, wins, open, programs }: MoneyStripProps) {
  const amount = amountIn(cash.currencies, currency);
  const others = cash.currencies.filter((entry) => entry.currency !== currency);
  const previousAmount = previous ? amountIn(previous.currencies, currency) : null;
  // Nothing in either period says nothing; leave the change out.
  const change =
    previousAmount === null || (amount === 0 && previousAmount === 0) ? null : amount - previousAmount;
  const partial = (flag: boolean) => (flag ? " (partial)" : "");

  return (
    <section
      aria-label={`${month.name} at a glance`}
      className="rounded-xl bg-board px-4 py-3.5 text-board-foreground sm:px-[18px] dark:ring-1 dark:ring-board-foreground/10"
    >
      <dl className="grid grid-cols-2 gap-x-7 gap-y-4 md:grid-cols-[1.25fr_1fr_1fr_1fr] md:items-end">
        <Figure label={`Cash collected · ${month.name}`} className="col-span-2 md:col-span-1">
          <span className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-condensed text-[30px] leading-[1.05] font-semibold text-primary tabular-nums">
              {formatCash(amount, currency)}
            </span>
            {others.map((entry) => (
              <span
                key={entry.currency}
                className="font-condensed text-[17px] leading-none font-semibold text-board-foreground tabular-nums"
              >
                {formatCash(entry.amountMinor, entry.currency)}
              </span>
            ))}
          </span>
          <Detail>
            {change !== null ? (
              <>
                <span
                  className={cn(
                    "font-semibold",
                    change > 0 ? "text-primary" : change < 0 ? "text-board-danger" : "text-board-foreground",
                  )}
                >
                  {change === 0 ? "No change" : formatCash(change, currency, true)}
                </span>{" "}
                {month.comparisonLabel} ·{" "}
              </>
            ) : null}
            {cash.paymentCount === 0
              ? month.isCurrent
                ? "No payments yet"
                : "No payments"
              : `${cash.paymentCount} ${cash.paymentCount === 1 ? "payment" : "payments"}`}
            {partial(cash.isPartial)}
          </Detail>
        </Figure>

        <Figure label="Won">
          <Value>{wins.won}</Value>
          <Detail>
            {wins.decided === 0
              ? month.isCurrent
                ? "No deals decided yet"
                : "No deals decided"
              : `of ${wins.decided} decided`}
            {partial(wins.isPartial)}
          </Detail>
        </Figure>

        <Figure label={month.isCurrent ? "Open deals" : "Open deals now"}>
          <Value>
            {open.count}
            {open.isPartial ? "+" : ""}
          </Value>
          <Detail>
            {open.count === 0 ? (
              "None open"
            ) : open.withoutNextStep === 0 ? (
              "Each has a next step"
            ) : (
              <span className="font-semibold text-warning">{open.withoutNextStep} with no next step</span>
            )}
          </Detail>
        </Figure>

        <Figure label="Programs" className="col-span-2 md:col-span-1">
          <Value>{programs.length}</Value>
          <Detail className="truncate" title={programs.join(" · ")}>
            {programs.length === 0 ? "None yet" : programs.join(" · ")}
          </Detail>
        </Figure>
      </dl>
    </section>
  );
}

function Figure({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <dt className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase">
        {label}
      </dt>
      <dd className="contents">{children}</dd>
    </div>
  );
}

function Value({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-1 font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums">{children}</span>
  );
}

function Detail({
  className,
  children,
  title,
}: {
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span title={title} className={cn("mt-0.5 text-[13px] text-board-foreground/75", className)}>
      {children}
    </span>
  );
}

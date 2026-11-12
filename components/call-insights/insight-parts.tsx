"use client";

import {
  createContext,
  use,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The parts the Call insights cards are built from: a ruled list of groups
 * (Income, Objections, Struggles, Goals), each holding chips. A chip names one
 * thing the prospect said and opens the words behind it; one chip is open at
 * a time in a card.
 *
 *   <Insights defaultOpenKey="objection:1">
 *     <InsightGroup label="Objections">
 *       <InsightChips>
 *         <InsightChip itemKey="objection:1" status={…}>Partner</InsightChip>
 *       </InsightChips>
 *       <InsightDetail itemKey="objection:1">…</InsightDetail>
 *     </InsightGroup>
 *   </Insights>
 */

type InsightsState = {
  openKey: string | null;
  toggle: (itemKey: string) => void;
  detailId: (itemKey: string) => string;
};

const InsightsContext = createContext<InsightsState | null>(null);

function useInsights(): InsightsState {
  const state = use(InsightsContext);
  if (!state) throw new Error("Insight parts must sit inside <Insights>.");
  return state;
}

/** Holds which chip is open. The card decides which one starts open. */
export function Insights({
  defaultOpenKey = null,
  children,
}: {
  defaultOpenKey?: string | null;
  children: ReactNode;
}) {
  const [openKey, setOpenKey] = useState<string | null>(defaultOpenKey);
  const baseId = useId();
  const state = useMemo<InsightsState>(
    () => ({
      openKey,
      toggle: (itemKey) =>
        setOpenKey((current) => (current === itemKey ? null : itemKey)),
      detailId: (itemKey) => `${baseId}-${itemKey}`,
    }),
    [openKey, baseId],
  );
  return (
    <InsightsContext value={state}>
      <dl className="@container">{children}</dl>
    </InsightsContext>
  );
}

/** A list of groups with nothing to open, as on the person page. */
export function InsightList({ children }: { children: ReactNode }) {
  return <dl className="@container">{children}</dl>;
}

/**
 * One ruled group: its condensed label in a narrow column, its chips and the
 * open chip's words beside it. On a narrow card the label sits above.
 */
export function InsightGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0 @md:grid-cols-[6.25rem_minmax(0,1fr)]">
      <dt className="font-condensed text-[0.6875rem] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase @md:pt-[0.5625rem]">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function InsightChips({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

const CHIP_SHAPE =
  "inline-flex min-h-7 max-w-full items-center gap-x-1.5 rounded-full border bg-card px-2.5 py-0.5 text-left text-[0.84375rem] leading-tight font-medium text-foreground";

/** A chip that opens the words behind it. */
export function InsightChip({
  itemKey,
  status,
  children,
}: {
  itemKey: string;
  /** Status words after the name: `<StatusWord>` elements. */
  status?: ReactNode;
  children: ReactNode;
}) {
  const { openKey, toggle, detailId } = useInsights();
  const open = openKey === itemKey;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? detailId(itemKey) : undefined}
      onClick={() => toggle(itemKey)}
      className={cn(
        CHIP_SHAPE,
        "touch-manipulation flex-wrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        open
          ? "border-foreground"
          : "border-input hover:border-muted-foreground hover:bg-muted",
      )}
    >
      {children}
      {status}
    </button>
  );
}

/** The same chip with nothing behind it. */
export function InsightTag({
  status,
  children,
}: {
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={cn(CHIP_SHAPE, "flex-wrap border-input")}>
      {children}
      {status}
    </span>
  );
}

const WORD_TONE = {
  open: "text-danger-ink",
  resolved: "text-primary-ink",
  unsure: "text-warning-ink",
  figure: "text-stage-follow-up-ink",
  muted: "text-muted-foreground",
} as const;

/** The condensed word on a chip: Open, Resolved, Not confirmed, an amount. */
export function StatusWord({
  tone,
  children,
}: {
  tone: keyof typeof WORD_TONE;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "font-condensed text-[0.6875rem] font-semibold tracking-[0.08em] whitespace-nowrap tabular-nums uppercase",
        WORD_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

const DETAIL_TONE = {
  confirmed: "border-primary",
  unsure: "border-warning",
  hidden: "border-input",
} as const;

/**
 * The open chip's words: a block under the chips with a rule down its left
 * edge, lime when Jev confirmed the item and amber when it didn't. Renders
 * nothing while its chip is closed.
 */
export function InsightDetail({
  itemKey,
  tone = "confirmed",
  children,
}: {
  itemKey: string;
  tone?: keyof typeof DETAIL_TONE;
  children: ReactNode;
}) {
  const { openKey, detailId } = useInsights();
  if (openKey !== itemKey) return null;
  return (
    <div
      id={detailId(itemKey)}
      className={cn(
        "mt-2 flex flex-col gap-1 rounded-r-md border-l-[3px] bg-muted px-3 py-2 text-sm leading-[1.45]",
        DETAIL_TONE[tone],
      )}
    >
      {children}
    </div>
  );
}

/** The prospect's own words, or the note that they went with the transcript. */
export function InsightQuote({ quote }: { quote: string | null }) {
  if (quote === null)
    return (
      <p className="text-muted-foreground">
        Quote deleted with the transcript. The category and result stay.
      </p>
    );
  return <p className="text-pretty break-words">&ldquo;{quote}&rdquo;</p>;
}

/** The small line under a quote: when it was said and what the check found. */
export function InsightMeta({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.8125rem] text-muted-foreground">
      {children}
    </p>
  );
}

/** A time in the recording, set as a figure. */
export function InsightTime({ at }: { at: string }) {
  return (
    <span className="font-condensed text-[0.875rem] font-semibold tracking-[0.02em] text-foreground tabular-nums">
      {at}
    </span>
  );
}

/**
 * An amount the prospect said, as a figure: "~6,000". Follow it with
 * `<InsightUnit>` for the words beside it ("a month · business revenue").
 */
export function InsightFigure({ children }: { children: ReactNode }) {
  return (
    <span className="font-condensed text-2xl leading-none font-semibold tabular-nums">
      {children}
    </span>
  );
}

/** The unit and what an amount is, in plain words beside its figure. */
export function InsightUnit({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("min-w-0 text-[0.84375rem]", className)}>
      {children}
    </span>
  );
}

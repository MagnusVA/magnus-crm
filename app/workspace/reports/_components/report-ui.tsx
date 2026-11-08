import type { ReactNode } from "react";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { FreshnessWords, type FreshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { PageBand } from "@/app/workspace/_components/page-band";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The pieces every report page is built from, in the Departures Board's
// grammar (DESIGN.md, The report band with figures; The Programs Card):
// the page root, the band with its range line, figure zones and filters,
// ruled cards that report their own state, notes, status words and the
// chart colours.

/** The page root: up to 1500px, one column, 14px gaps, and the container the page folds by. */
export const REPORT_PAGE = "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** A row of cards side by side from `@5xl`, each at its own height. */
export const REPORT_PAIR = "grid items-start gap-3.5 short:gap-3 @5xl:grid-cols-2";

// Paper figures and column heads (DESIGN.md, The Condensed Figures Rule).
export const FIGURE_15 = "font-condensed text-[15px] font-semibold tabular-nums";
export const FIGURE_20 = "font-condensed text-[20px] leading-none font-semibold tabular-nums";
export const COLUMN_HEAD =
  "min-h-7 px-2.5 py-1 align-bottom font-condensed text-[11px] leading-tight font-semibold tracking-[0.14em] text-muted-foreground uppercase";
export const LABEL = "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/**
 * Board-tone triggers for a band's selects (the Sales calls currency
 * select's grammar). The band scopes `dark`, so dark fills are overridden too.
 */
export const BAND_SELECT =
  "h-[34px]! min-w-0 rounded-[7px] border-board-foreground/15 bg-board-raised text-[13px] text-board-foreground hover:bg-board-foreground/10 dark:bg-board-raised dark:hover:bg-board-foreground/10 [&_svg]:text-board-muted! data-[placeholder]:text-board-muted";

/** A band button (Export and the like): 34px, board-raised, 15% light border. */
export const BAND_BUTTON =
  "h-[34px] rounded-[7px] border border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

// ─── The band ────────────────────────────────────────────────────────────────

/**
 * A report's header: the title, one 13px line naming the range in words, the
 * freshness words and how days are counted (from `@3xl`), the date controls
 * in the action slot, and under the title the figure zones and the filters.
 */
export function ReportBand({
  title,
  range,
  freshness,
  dayLine,
  sentence,
  actions,
  figures,
  filters,
}: {
  title: string;
  /** The range in words, "This week · Oct 27 – Nov 2" (`reportRangeWords`). */
  range?: ReactNode;
  /** The freshness words, shown only once the page's data has loaded. */
  freshness?: FreshnessSummary | null;
  /** How days are counted, from `@3xl`: "Days run 1:00 am to 1:00 am, …". */
  dayLine?: ReactNode;
  /** One short sentence, when the range line doesn't say what the page is for. */
  sentence?: ReactNode;
  /** The date controls (board tone), right of the title. */
  actions?: ReactNode;
  /** `ReportFigures`, under a board-line rule. */
  figures?: ReactNode;
  /** Filters (board-tone selects), under the figures. */
  filters?: ReactNode;
}) {
  const parts: ReactNode[] = [];
  if (range) parts.push(<span key="range" className="font-medium text-board-foreground">{range}</span>);
  if (freshness && freshness.kind === "line") parts.push(<FreshnessWords key="fresh" summary={freshness} />);
  if (sentence) parts.push(<span key="sentence">{sentence}</span>);
  return (
    <PageBand
      title={title}
      description={
        parts.length > 0 || dayLine ? (
          <>
            {parts.map((part, index) => (
              <span key={index}>
                {index > 0 ? " · " : null}
                {part}
              </span>
            ))}
            {dayLine ? (
              <span className="hidden @3xl:inline">
                {parts.length > 0 ? " · " : null}
                {dayLine}
              </span>
            ) : null}
          </>
        ) : undefined
      }
      actions={actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : undefined}
    >
      {figures || filters ? (
        <div className="flex flex-col">
          {figures}
          {filters ? (
            <div
              role="group"
              aria-label="Filters"
              className="-mx-4 flex flex-wrap items-center gap-2 border-t border-board-line px-4 py-2.5 @lg:-mx-[18px] @lg:px-[18px]"
            >
              {filters}
            </div>
          ) : null}
        </div>
      ) : null}
    </PageBand>
  );
}

const ZONE_LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
const ZONE_FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";
const ZONE_PROOF = "text-[13px] text-board-foreground/75";

/**
 * The band's figure zones in one ruled grid (1px board-line gaps), under a
 * board-line rule that runs edge to edge. `columns` sets the grid by the page's
 * width, two a row on a phone by default.
 */
export function ReportFigures({
  columns = "grid-cols-2 @3xl:grid-cols-4",
  reloading,
  children,
}: {
  columns?: string;
  /** Kept figures dim to 60% while the next range loads. */
  reloading?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Headline figures"
      aria-busy={reloading || undefined}
      className={cn(
        "-mx-4 grid gap-px border-t border-board-line bg-board-line transition-opacity duration-200 @lg:-mx-[18px]",
        columns,
        reloading && "opacity-60",
      )}
    >
      {children}
    </div>
  );
}

/**
 * One figure zone: an 11px condensed label (with a `HelpTip` when it needs
 * one), a 30px condensed figure and a 13px proof line. `figure` undefined
 * draws the loading bones at the same height.
 */
export function FigureZone({
  label,
  help,
  figure,
  proof,
  figureClassName,
  className,
}: {
  label: string;
  help?: ReactNode;
  figure: ReactNode | undefined;
  proof?: ReactNode;
  /** `text-primary` for cash, as on the book panel. */
  figureClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5", className)}>
      <p className={ZONE_LABEL}>{help ? <HelpTip tip={help}>{label}</HelpTip> : label}</p>
      {figure === undefined ? (
        <>
          <Skeleton className="h-8 w-20 bg-board-raised" />
          <Skeleton className="h-3.5 w-36 max-w-full bg-board-raised" />
        </>
      ) : (
        <>
          <div className={cn(ZONE_FIGURE, "flex flex-wrap items-baseline gap-x-2", figureClassName)}>{figure}</div>
          {proof ? <p className={ZONE_PROOF}>{proof}</p> : null}
        </>
      )}
    </div>
  );
}

/** A second currency's figure beside the main one, at 17px. */
export function OtherFigure({ children }: { children: ReactNode }) {
  return <span className="font-condensed text-[17px] font-semibold text-board-foreground tabular-nums">{children}</span>;
}

/** A unit after a figure ("/day", "h"), 13px medium board-muted. */
export function FigureUnit({ children }: { children: ReactNode }) {
  return <span className="font-sans text-[13px] font-medium text-board-muted">{children}</span>;
}

// ─── Cards ───────────────────────────────────────────────────────────────────

/**
 * A ruled report card: the 44px title row with meta, and a body that is its
 * own container (`@container/<name>`) so it folds by its own width. The body
 * reports its own state in place: pass `loading` for skeleton rows at the real
 * height, or render `SectionEmpty` / `SectionError` as children.
 */
export function ReportCard({
  title,
  meta,
  container,
  reloading,
  className,
  children,
  footer,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /**
   * The body's container class, written out in full so Tailwind sees it:
   * "@container/closers". Defaults to an unnamed `@container`.
   */
  container?: string;
  /** Kept data dims to 60% while the next range loads. */
  reloading?: boolean;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <DetailCard title={title} meta={meta} className={cn("min-w-0 overflow-hidden", className)}>
      <div
        aria-busy={reloading || undefined}
        className={cn(
          "min-w-0 transition-opacity duration-200",
          container ?? "@container",
          reloading && "opacity-60",
        )}
      >
        {children}
      </div>
      {footer}
    </DetailCard>
  );
}

/** Skeleton rows standing at the real row height, labelled for screen readers. */
export function RowsSkeleton({ rows = 5, rowHeight = "h-11", label }: { rows?: number; rowHeight?: string; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn("flex items-center gap-4 border-b px-4 last:border-b-0", rowHeight)}>
          <Skeleton className="h-4 w-40 max-w-[40%]" />
          <Skeleton className="h-2 flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

/** A chart's skeleton at the chart's height. */
export function ChartSkeleton({ height = "h-64", label }: { height?: string; label: string }) {
  return (
    <div role="status" aria-label={label} className="px-4 py-3">
      <Skeleton className={cn("w-full rounded-md", height)} />
    </div>
  );
}

/**
 * One 13px ruled line above a card's rows that says a scope, cap or partial
 * read in words (DESIGN.md: never in a tooltip). `lead` is set in medium ink:
 * "Partial.", "Capped.".
 */
export function ReportNote({ lead, children, className }: { lead?: string; children: ReactNode; className?: string }) {
  return (
    <p className={cn("border-b px-4 py-2 text-[13px] text-muted-foreground", className)}>
      {lead ? <span className="font-medium text-foreground">{lead} </span> : null}
      {children}
    </p>
  );
}

/** A table's total row: last, on a 40% muted fill, every figure in ink. */
export const TOTAL_ROW = "bg-muted/40 font-semibold";

// ─── Status words ────────────────────────────────────────────────────────────

export type StatusTone = "owed" | "failed" | "live" | "done";

const STATUS_TONE: Record<StatusTone, string> = {
  owed: "text-warning-ink",
  failed: "text-danger-ink",
  live: "text-foreground",
  done: "text-muted-foreground",
};

/**
 * One status word per row, condensed uppercase, coloured by meaning (rule 6):
 * amber for owed or waiting, red for failed, expired or blocked, ink for live
 * and healthy, slate for done or neutral.
 */
export function StatusWord({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        STATUS_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ─── Charts ──────────────────────────────────────────────────────────────────

/**
 * Categorical series colours, in order: blue, teal, ink, amber, slate. Ink
 * stands in for the lime chart token, which marks the next action on the
 * paper (DESIGN.md, Respark's bucket swatches). Stage data takes the stage
 * scale instead (`STAGE_FILL`), and a single measure is ink at 75%.
 */
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--foreground)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

export function seriesColor(index: number) {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** The one colour for a chart with a single measure: ink at 75%. */
export const SINGLE_SERIES = "color-mix(in oklab, var(--foreground) 75%, transparent)";

/** Stage-scale fills for data that is a deal stage or a call's result (The One Scale Rule). */
export const STAGE_FILL = {
  booked: "var(--stage-booked)",
  held: "var(--stage-held)",
  followUp: "var(--stage-follow-up)",
  won: "var(--stage-won)",
  lost: "var(--stage-lost)",
  owed: "var(--warning)",
} as const;

/** Recharts axis props: 12px slate ticks, no axis or tick lines. */
export const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 12, fill: "var(--muted-foreground)" },
} as const;

/** Recharts grid: horizontal hairlines in the rule colour only. */
export const GRID_PROPS = { vertical: false, stroke: "var(--border)", strokeDasharray: "0" } as const;

export type BarListRow = {
  key: string;
  label: ReactNode;
  /** A 13px slate line under the label. */
  meta?: ReactNode;
  value: number;
  /** The measure as shown on the right ("$12,400", "14 calls"). */
  display: ReactNode;
  /** A fill other than ink 75%, such as a stage colour. */
  fill?: string;
};

/**
 * Ruled bar rows (The Programs Card's Bars view): the label over a 13px slate
 * meta line, an 8px bar on a muted track scaled to the largest row, and the
 * measure at 15px condensed on the right (slate at zero). From `@lg` of the
 * nearest container the three sit on one line; narrower the bar takes its own
 * line under them.
 */
export function BarList({ rows, label, labelColumn = "13rem" }: { rows: BarListRow[]; label: string; labelColumn?: string }) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  return (
    <ul aria-label={label} className="flex flex-col">
      {rows.map((row) => (
        <li
          key={row.key}
          style={{ ["--bar-label" as string]: labelColumn }}
          className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 last:border-b-0 @lg:grid-cols-[minmax(0,var(--bar-label))_minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <p className="truncate font-medium">{row.label}</p>
            {row.meta ? <p className="truncate text-[13px] text-muted-foreground">{row.meta}</p> : null}
          </div>
          <div aria-hidden="true" className="order-last col-span-2 h-2 overflow-hidden rounded-[3px] bg-muted @lg:order-none @lg:col-span-1">
            <div
              className="h-full rounded-[3px]"
              style={{
                width: max > 0 ? `${Math.max((row.value / max) * 100, row.value > 0 ? 1.5 : 0)}%` : 0,
                background: row.fill ?? SINGLE_SERIES,
              }}
            />
          </div>
          <p className={cn(FIGURE_15, "text-right whitespace-nowrap", row.value === 0 && "text-muted-foreground")}>{row.display}</p>
        </li>
      ))}
    </ul>
  );
}

/** A chart legend as one 13px line of 10px swatches, under or above a chart. */
export function ChartLegend({ items }: { items: Array<{ key: string; label: ReactNode; color: string }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[13px] text-muted-foreground">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

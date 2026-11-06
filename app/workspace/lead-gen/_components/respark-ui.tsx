import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { resparkBucketLabel } from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { bucketSwatchClass } from "./respark-format";

// Pieces shared by the Respark page, its batch, the person sheet and the
// skeleton (DESIGN.md, Respark). No hooks here, so loading.tsx can draw the
// same frame.

/** The page root: the container the page folds by, on an 1100px measure. */
export const RESPARK_ROOT =
  "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** The white card every section sits in. */
export const RESPARK_CARD = "min-w-0 overflow-hidden rounded-xl border border-border bg-card";

/** Column heads and group labels: 11px condensed caps on the rule above the rows. */
export const LABEL =
  "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/** A date, time or count in a row. */
export const FIGURE = "font-condensed text-[15px] leading-5 font-semibold tabular-nums";

/** A date in a ruled column: condensed and slate. */
export const DATE = "font-condensed text-[14px] leading-5 font-semibold text-muted-foreground tabular-nums";

/** One condensed status word per row; the caller adds its ink. */
export const STATUS_WORD =
  "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** A card's 44px title row. */
export const TITLE_ROW = "flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-2";

// ─── The band's zones ─────────────────────────────────────────────────────

const ZONE_LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-board-muted uppercase";
export const ZONE_FIGURE = "font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums";

/** The band's figure row: zones in one grid ruled by 1px board-line gaps. */
export function BandZones({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("-mx-4 grid gap-px border-t border-board-line bg-board-line @lg:-mx-[18px]", className)}
    >
      {children}
    </div>
  );
}

export function Zone({ label, className, children }: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px]", className)}>
      <p className={ZONE_LABEL}>{label}</p>
      {children}
    </div>
  );
}

/** A zone's figure before its numbers arrive. */
export function ZoneBone() {
  return <Skeleton className="h-8 w-14 bg-board-raised" />;
}

// ─── Small pieces ─────────────────────────────────────────────────────────

/** The bucket's categorical swatch. */
export function Swatch({ bucket, className }: { bucket: number; className?: string }) {
  return <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", bucketSwatchClass(bucket), className)} />;
}

/** The bucket as a swatch and a condensed slate word. */
export function BucketWord({ bucket, className }: { bucket: number; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Swatch bucket={bucket} />
      <span className={cn(STATUS_WORD, "truncate font-semibold text-muted-foreground")}>{resparkBucketLabel(bucket)}</span>
    </span>
  );
}

/** One dense fact: a slate label column beside its value, about 28px tall. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-h-7 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 py-1", className)}>
      <dt className="text-[13px] leading-5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm leading-5 wrap-break-word">{children}</dd>
    </div>
  );
}

/** A slate stand-in for a missing value. */
export function None({ children = "None" }: { children?: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

const KEYS: Array<[string, string]> = [
  ["O", "open"],
  ["R", "resparked"],
  ["N", "not a fit"],
  ["S", "skip"],
  ["J/K", "next"],
];

/** The batch's keys as board-tone chips; phones have no keyboard, so they hide below @3xl. */
export function KeyHints({ className }: { className?: string }) {
  return (
    <p
      aria-label="Keys: O open, R resparked, N not a fit, S skip, J and K next and previous"
      className={cn("hidden flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-board-muted @3xl:flex", className)}
    >
      {KEYS.map(([letter, label]) => (
        <span key={letter} aria-hidden="true" className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Kbd className="h-[22px] min-w-[22px] border border-board-foreground/15 bg-board-raised px-1.5 font-condensed text-[13px] font-semibold text-board-foreground">
            {letter}
          </Kbd>
          {label}
        </span>
      ))}
    </p>
  );
}

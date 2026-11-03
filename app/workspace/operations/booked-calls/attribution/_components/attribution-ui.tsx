import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The Attribution page's shared pieces in the Departures Board system
// (DESIGN.md): label-style column heads over ruled 44px rows, one condensed
// status word per row in a token ink, and the paper-tone segmented toggle.

/** Label style: names a column, never restates a heading. */
export const HEAD =
  "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/** Codes, UTM values and URLs to copy. */
export const CODE = "font-mono text-[13px]";

/** A plain ruled table inside a card: heads above, rows ruled, no zebra. */
export function RuledTable({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table aria-label={label} className={cn("w-full border-collapse text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  className,
  children,
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(HEAD, "h-7 px-4 pt-2 pb-1 text-left align-bottom whitespace-nowrap", className)}
      {...props}
    >
      {children}
    </th>
  );
}

/** A ruled body row; `interactive` adds the hover fill for rows that act. */
export function Tr({
  interactive = false,
  className,
  children,
  ...props
}: React.ComponentProps<"tr"> & { interactive?: boolean }) {
  return (
    <tr className={cn("border-t", interactive && "hover:bg-muted/60", className)} {...props}>
      {children}
    </tr>
  );
}

export function Td({ className, children, ...props }: React.ComponentProps<"td">) {
  return (
    <td className={cn("h-11 px-4 py-1.5 align-middle", className)} {...props}>
      {children}
    </td>
  );
}

export type StatusTone = "active" | "inactive" | "attention" | "broken";

const STATUS_INK: Record<StatusTone, string> = {
  active: "text-foreground",
  inactive: "text-muted-foreground",
  attention: "text-warning-ink",
  broken: "text-danger-ink",
};

const STATUS_DOT: Record<StatusTone, string> = {
  active: "bg-stage-follow-up",
  inactive: "bg-stage-held",
  attention: "bg-warning",
  broken: "bg-stage-lost",
};

/** One condensed uppercase status word in its token ink, with a 6px dot. */
export function StatusWord({
  tone,
  dot = true,
  className,
  children,
}: {
  tone: StatusTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        STATUS_INK[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone])} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The amber flag: a 20px chip for something that needs attention. */
export function AttentionFlag({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center truncate rounded-[4px] bg-warning-surface px-1.5 font-condensed text-[11px] font-bold tracking-[0.1em] whitespace-nowrap text-warning-ink uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A 13px slate sentence as the card's first ruled row. */
export function CardNote({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("border-b px-4 py-2.5 text-[13px] text-muted-foreground", className)}>{children}</p>;
}

/** Paper-tone segmented toggle (DateRangePicker's paper tone). */
export const SEGMENT_TRACK = "inline-flex h-[30px] max-w-full items-center gap-0.5 overflow-x-auto rounded-[7px] bg-muted p-0.5";
export const SEGMENT_ITEM =
  "inline-flex h-full shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgb(20_26_40/0.12)]";

/**
 * Loading rows at the real 44px row height under the real column heads,
 * labelled for screen readers.
 */
export function TableSkeleton({
  label,
  heads,
  rows = 4,
  rowClassName = "h-11",
}: {
  label: string;
  heads: string[];
  rows?: number;
  rowClassName?: string;
}) {
  return (
    <div role="status" aria-label={label}>
      <div aria-hidden="true" className="flex min-h-7 items-end gap-4 px-4 pt-2 pb-1">
        {heads.map((head) => (
          <span key={head} className={cn(HEAD, "flex-1 whitespace-nowrap")}>
            {head}
          </span>
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className={cn("flex items-center gap-4 border-t px-4", rowClassName)}>
          {heads.map((head) => (
            <span key={head} className="flex-1">
              <Skeleton className="h-3.5 w-3/4" />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

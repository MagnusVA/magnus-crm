"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CalendlyDot } from "../../_components/calendly-dot";
import { KeyHint } from "../../_components/event-types/key-hint";

export type QueueRow = {
  id: string;
  name: string;
  color: string | undefined;
  /** Members in a stack; 1 for a single card. */
  count: number;
  /** "25K Accelerator · Standard", "Not a sales call · Personal calendar", "No suggestion" */
  meta: string;
  later: boolean;
};

export type SessionRow = {
  id: string;
  label: string;
  destination: string;
  kind: "booking" | "not_sales";
};

const CARD = "overflow-hidden rounded-xl border border-border bg-card";
const HEAD = "flex min-h-11 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2";

/** "Up next": every card after the focused one, stacks shown as one row with their count. */
export function UpNext({
  rows,
  busy,
  onFocus,
  onAcceptStack,
}: {
  rows: QueueRow[];
  busy: boolean;
  onFocus: (id: string) => void;
  onAcceptStack: (id: string) => void;
}) {
  return (
    <section aria-labelledby="inbox-up-next" className={CARD}>
      <div className={HEAD}>
        <h2 id="inbox-up-next" className="text-[15px] font-semibold">
          Up next
        </h2>
        <span className="text-[13px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? "card" : "cards"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-2.5 text-[13.5px] text-muted-foreground">Nothing after this one.</p>
      ) : (
        <ul className="max-h-[min(36rem,calc(100dvh-22rem))] min-h-0 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id} className="group relative border-t border-border first:border-t-0">
              <button
                type="button"
                onClick={(event) => {
                  // Leave focus on the page, so Enter takes the new card's suggestion.
                  event.currentTarget.blur();
                  onFocus(row.id);
                }}
                className="flex w-full items-start gap-2.5 px-4 py-[9px] text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                {row.count > 1 ? (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground font-condensed text-[11px] font-bold text-background shadow-[2px_2px_0_#c9d0dc] dark:shadow-[2px_2px_0_#3a4256]"
                  >
                    {row.count}
                  </span>
                ) : (
                  <CalendlyDot color={row.color} className="mt-[5px] size-2.5" />
                )}
                <span className={cn("min-w-0 flex-1", row.count > 1 && "pr-16")}>
                  <span className="block truncate text-[13.5px] font-medium">{row.name}</span>
                  <small className="block truncate text-[12.5px] text-muted-foreground">
                    {row.meta}
                    {row.later ? " · later" : ""}
                  </small>
                </span>
              </button>
              {row.count > 1 ? (
                <Button
                  variant="outline"
                  size="xs"
                  className="absolute top-2 right-3 bg-card"
                  disabled={busy}
                  onClick={() => onAcceptStack(row.id)}
                  aria-label={`File all ${row.count}: ${row.meta}`}
                >
                  File all
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What this visit sorted, newest first, with the one Undo. */
export function SortedThisSession({ rows, total, onUndo, canUndo }: { rows: SessionRow[]; total: number; onUndo: () => void; canUndo: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="inbox-session" className={CARD}>
      <div className={HEAD}>
        <h2 id="inbox-session" className="text-[15px] font-semibold">
          Sorted this session
        </h2>
        <span className="font-condensed text-[13px] text-muted-foreground tabular-nums">{total}</span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 px-2 font-normal" onClick={onUndo} disabled={!canUndo} aria-keyshortcuts="U">
          <KeyHint>U</KeyHint>
          Undo
        </Button>
      </div>
      <ul>
        {rows.slice(0, 7).map((row) => (
          <li key={row.id} className="flex items-start gap-2.5 border-t border-border px-4 py-[9px] first:border-t-0">
            <span
              className={cn(
                "mt-[3px] w-[72px] shrink-0 font-condensed text-[11.5px] leading-[1.1] font-bold tracking-[0.08em] uppercase",
                row.kind === "booking" ? "text-stage-follow-up-ink" : "text-muted-foreground",
              )}
            >
              {row.kind === "booking" ? "Booking" : "Not sales"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{row.label}</span>
              <small className="block truncate text-[12.5px] text-muted-foreground">{row.destination}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

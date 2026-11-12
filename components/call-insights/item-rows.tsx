"use client";

import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const CHIP_TONE = {
  muted: "bg-muted text-muted-foreground",
  ink: "border border-border text-foreground",
  lime: "bg-primary/15 text-primary-ink",
  warning: "bg-warning-surface text-warning-ink",
} as const;

/** A 20px condensed chip, the app's stage-chip shape, in a neutral tone. */
export function Chip({
  tone = "muted",
  className,
  children,
}: {
  tone?: keyof typeof CHIP_TONE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded px-1.5 font-condensed text-[0.6875rem] font-bold tracking-[0.1em] whitespace-nowrap uppercase",
        CHIP_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The 11px condensed label that heads a group of rows, on the rule above them. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="border-b bg-background px-4 py-1.5 font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

/**
 * One ruled row that opens to show what was said: the summary line with its
 * chips and trailing word, then the one-line statement and the quote.
 */
export function ItemRow({
  summary,
  chips,
  trailing,
  children,
}: {
  summary: ReactNode;
  chips?: ReactNode;
  trailing?: ReactNode;
  /** The opened part: statement and quote. */
  children: ReactNode;
}) {
  return (
    <Collapsible asChild>
      <li className="border-b last:border-b-0">
        <CollapsibleTrigger className="group/item flex min-h-10 w-full items-center gap-x-2 px-4 py-2 text-left text-sm text-foreground transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0">{summary}</span>
            {chips}
          </span>
          {trailing ? <span className="shrink-0">{trailing}</span> : null}
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/item:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-1 px-4 pb-3 text-[0.8125rem] leading-[1.45] text-foreground">
          {children}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

/** A quote under a statement: `04:18 · "…"`, or the note that it was deleted. */
export function QuoteText({
  line,
  deleted,
}: {
  line: string | null;
  deleted?: string;
}) {
  if (line === null)
    return (
      <p className="text-muted-foreground">
        {deleted ?? "Quote deleted with the transcript."}
      </p>
    );
  return <p className="text-muted-foreground tabular-nums">{line}</p>;
}

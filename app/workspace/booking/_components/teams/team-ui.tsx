import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Concept B's small pieces for the DM teams pages, in the app's tokens.

/** Column heads and field labels: 11px condensed caps on the rule above the rows. */
export const LABEL = "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/** A condensed figure in a column: counts and goals. */
export const FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

/** The white card every section sits in. */
export const CARD = "min-w-0 overflow-hidden rounded-xl border border-border bg-card";

/** A card's 44px title row: title, meta, then actions pushed right. */
export function CardHead({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-2">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {meta ? <span className="text-[13px] text-muted-foreground">{meta}</span> : null}
      {children ? <span className="ml-auto flex items-center gap-2">{children}</span> : null}
    </div>
  );
}

/** "Jorge Bulnes" -> "JB"; one word -> its first two letters. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** A round initials avatar; `stacked` overlaps it on the one before (rosters). */
export function Initials({ name, size = "md", stacked }: { name: string; size?: "sm" | "md"; stacked?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-condensed font-bold tracking-[0.06em] text-muted-foreground",
        size === "md" ? "size-7 text-[11px]" : "size-6 text-[10px]",
        stacked && "-ml-[5px] shadow-[0_0_0_2px_var(--color-card)] first:ml-0",
      )}
    >
      {initials(name)}
    </span>
  );
}

/** ACTIVE in teal ink, DISABLED in slate: one condensed status word. */
export function ActiveWord({ active, className }: { active: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        active ? "text-stage-follow-up-ink" : "text-muted-foreground",
        className,
      )}
    >
      {active ? "Active" : "Disabled"}
    </span>
  );
}

/** A UTM value set in mono on a muted chip. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      translate="no"
      className={cn("rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[12.5px] tracking-[-0.01em] break-all", className)}
    >
      {children}
    </code>
  );
}

/** "DM Team Cole" -> "Cole", for "What Cole's closers get". */
export function teamShortName(name: string) {
  const short = name.replace(/^\s*dm[\s_-]*team[\s_-]+/i, "").trim();
  return /\p{L}/u.test(short) ? short : name;
}

/** "Ana Alonzo" -> "Ana". */
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

/** "today", "yesterday", "3 days ago". */
export function daysAgo(timestamp: number, now = Date.now()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.ceil((startOfToday.getTime() - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A label that explains itself on hover or focus: a dotted underline, and the
 * explanation in a tooltip. Keyboard users reach it with Tab.
 */
export function HelpTip({
  tip,
  children,
  className,
  side = "top",
}: {
  tip: ReactNode;
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "cursor-help rounded-[3px] underline decoration-current/35 decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[17rem] text-[12.5px] leading-snug font-normal tracking-normal normal-case">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

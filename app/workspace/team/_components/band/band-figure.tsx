"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The Team band's figures, shared by every section's figures file
// (band/*-figures.tsx), so each section fills its own without touching the band.

export const BAND_LABEL =
  "font-condensed text-[11px] leading-none font-semibold tracking-[0.14em] whitespace-nowrap text-board-muted uppercase";

/** A row of figures on the band's right. */
export function BandFigures({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap">{children}</div>;
}

/** What sits in the figures' place while they load: same height, no jump. */
export function BandFiguresPlaceholder() {
  return <div className="h-[62px]" aria-hidden />;
}

/**
 * One figure: a condensed caps label, a big number, and a caption. `tip`
 * explains it on hover and focus. With `href` the whole figure is a link and
 * the caption reads as one (underlined), like "Show them".
 */
export function BandFigure({
  label,
  tip,
  value,
  of,
  unit,
  caption,
  tone = "default",
  href,
}: {
  label: string;
  tip?: ReactNode;
  value: number | string;
  /** "2/4": the denominator, small and muted. */
  of?: number;
  /** "402h": a small unit after the value. */
  unit?: string;
  caption?: ReactNode;
  tone?: "default" | "danger" | "warning";
  href?: string;
}) {
  const body = (
    <>
      <span className={BAND_LABEL}>{label}</span>
      <span
        className={cn(
          "mt-1.5 flex items-baseline gap-px font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums",
          tone === "danger" && "text-board-danger",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
        {unit ? <small className="text-[17px] font-semibold text-board-muted">{unit}</small> : null}
        {of !== undefined ? <small className="text-[17px] font-semibold text-board-muted">/{of}</small> : null}
      </span>
      {caption ? (
        <span
          className={cn(
            "text-[12px] whitespace-nowrap text-board-muted",
            href && "text-board-foreground underline decoration-board-foreground/40 underline-offset-2",
          )}
        >
          {caption}
        </span>
      ) : null}
    </>
  );
  const className = "flex min-w-[92px] flex-col border-l border-board-line px-4 py-0.5 text-left";
  const element = href ? (
    <Link
      href={href}
      className={cn(className, "outline-none hover:bg-board-foreground/5 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </Link>
  ) : (
    <div
      tabIndex={tip ? 0 : undefined}
      className={cn(className, tip && "cursor-help outline-none focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </div>
  );
  if (!tip) return element;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[17rem] text-[12.5px] leading-snug">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** The outline button style for actions that sit on the navy band. */
export const BOARD_BUTTON =
  "border-board-foreground/15 bg-board-raised text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

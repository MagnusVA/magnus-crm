"use client";

import type { ReactNode } from "react";
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

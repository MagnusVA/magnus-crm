"use client";

import { ArrowDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The strip along the bottom of an expanded list that says more rows sit
 * below the fold; clicking it scrolls to the end. Takes `hintProps` from
 * `useExpandInPlace` and sits in a `relative` wrapper around the list. At
 * the end of the list it fades out and leaves the tab order.
 */
export function ScrollMoreHint({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      inert={!visible}
      aria-hidden={!visible}
      className={cn(
        "absolute inset-x-0 bottom-0 flex h-7 items-center justify-center gap-1.5 border-t bg-card/95 text-[12px] font-medium text-muted-foreground outline-none transition-opacity duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      Scroll to the bottom to see more
      <ArrowDownIcon aria-hidden className="size-3.5" />
    </button>
  );
}

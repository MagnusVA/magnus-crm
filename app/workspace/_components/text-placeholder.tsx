import { cn } from "@/lib/utils";

/**
 * A pulsing stand-in for text that hasn't loaded. It is transparent text in
 * the surrounding font, so its line is exactly as tall as the loaded text's
 * and nothing moves when the real text replaces it. `sample` sets the width.
 * The default fill is for the navy band; pass a class for paper.
 */
export function TextPlaceholder({ sample, className }: { sample: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-board-foreground/10 text-transparent select-none motion-reduce:animate-none",
        className,
      )}
    >
      {sample}
    </span>
  );
}

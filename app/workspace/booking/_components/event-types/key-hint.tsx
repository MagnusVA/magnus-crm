import { cn } from "@/lib/utils";

/**
 * A keyboard hint inside a button or a help line: a small raised key in
 * Barlow Condensed ("↵", "1", "P"). Decorative, so screen readers skip it;
 * put the shortcut in `aria-keyshortcuts` on the control instead.
 */
export function KeyHint({ children, className, tone = "default" }: { children: React.ReactNode; className?: string; tone?: "default" | "lime" | "board" }) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[4px] border border-b-2 px-1 font-condensed text-[11px] leading-none font-semibold tracking-[0.04em]",
        tone === "default" && "border-input bg-card text-muted-foreground",
        tone === "lime" && "border-primary-foreground/25 bg-white/35 text-primary-foreground",
        tone === "board" && "border-white/25 bg-transparent text-board-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

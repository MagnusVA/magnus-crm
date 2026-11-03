import { cn } from "@/lib/utils";

/** Calendly's colour for the event type, as a dot (8px unless sized; hidden from screen readers). */
export function CalendlyDot({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full border border-foreground/15", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

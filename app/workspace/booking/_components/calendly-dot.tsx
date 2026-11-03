/** Calendly's colour for the event type, as an 8px dot (hidden from screen readers). */
export function CalendlyDot({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full border border-foreground/15"
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

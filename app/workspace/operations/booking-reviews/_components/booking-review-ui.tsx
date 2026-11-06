import { formatClock, formatDateTime } from "@/app/workspace/closer/_components/today-time";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { cn } from "@/lib/utils";

// Words the booking review list and the review page share.

/** The status word's type: 13px condensed bold uppercase in its ink. */
export const REVIEW_WORD_CLASS = "font-condensed text-[13px] leading-none font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/**
 * One word per review: HELD in danger ink (the call is missing from the
 * CRM), DECIDE in amber (the admin owes a decision), RESOLVED in slate.
 */
export function ReviewStatusWord({
  kind,
  open,
  className,
}: {
  kind: "held" | "attached";
  open: boolean;
  className?: string;
}) {
  const [word, ink] = !open
    ? ["Resolved", "text-muted-foreground"]
    : kind === "held"
      ? ["Held", "text-danger-ink"]
      : ["Decide", "text-warning-ink"];
  return <span className={cn(ink, className)}>{word}</span>;
}

/** "Today 2:15 PM" on today's business day, else "Nov 4, 2:15 PM", in the tenant's time zone. */
export function receivedWords(at: number, now: number, setting: BusinessDaySetting) {
  return businessDateForInstant(at, setting) === businessDateForInstant(now, setting)
    ? `Today ${formatClock(at, setting.timeZone)}`
    : formatDateTime(at, setting.timeZone);
}

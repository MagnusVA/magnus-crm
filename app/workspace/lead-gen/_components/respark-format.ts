import {
  DEAL_STAGE_CONFIG,
  isSystemLossReason,
  SYSTEM_LOSS_REASON_LABELS,
  type DealOutcome,
  type DealStage,
} from "@/convex/opportunities/stages";

// Respark dates follow the tenant's business-day zone, like the hold.

// The pool's five buckets are categories, so they take the chart tokens, on
// the cards, the Next batch card and the person sheet alike. They are never
// status colours. Lime (chart-3) is skipped because lime marks the next
// action; ink stands in for it.
const BUCKET_SWATCHES: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-foreground",
  4: "bg-chart-4",
  5: "bg-chart-5",
};

export function bucketSwatchClass(bucket: number) {
  return BUCKET_SWATCHES[bucket] ?? "bg-chart-5";
}

// Formatters are costly to build; one per zone and variant, reused.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, options: Intl.DateTimeFormatOptions) {
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(key.startsWith("clock:") ? "en-GB" : "en-US", options);
    formatters.set(key, cached);
  }
  return cached;
}

/** "01:00" in the zone. */
export function formatClock(ms: number, timeZone: string) {
  return formatter(`clock:${timeZone}`, { hour: "2-digit", minute: "2-digit", timeZone }).format(ms);
}

/** "Jul 14", with the year when it isn't this year's. */
export function formatDay(ms: number, timeZone: string, now = Date.now()) {
  const year = formatter(`year:${timeZone}`, { year: "numeric", timeZone });
  const sameYear = year.format(ms) === year.format(now);
  return formatter(`day:${sameYear}:${timeZone}`, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone,
  }).format(ms);
}

export function lossReasonText(reason: string | null) {
  if (!reason) return "no reason given";
  return isSystemLossReason(reason) ? SYSTEM_LOSS_REASON_LABELS[reason] : reason;
}

/** "Lost: No-show", "Won", or the open stage's label. */
export function dealText(deal: { stage: DealStage; outcome: DealOutcome; lostReason: string | null }) {
  if (deal.outcome === "lost") return `Lost: ${lossReasonText(deal.lostReason)}`;
  if (deal.outcome === "won") return "Won";
  return `Open, ${DEAL_STAGE_CONFIG[deal.stage].label}`;
}

export function displayHandle(handle: string | null | undefined) {
  const clean = handle?.trim().replace(/^@+/, "");
  return clean ? `@${clean}` : null;
}

import {
  DEAL_STAGE_CONFIG,
  isSystemLossReason,
  SYSTEM_LOSS_REASON_LABELS,
  type DealOutcome,
  type DealStage,
} from "@/convex/opportunities/stages";

// Respark dates follow the tenant's business-day zone, like the hold.

const BUCKET_SWATCHES: Record<number, string> = {
  1: "bg-emerald-500",
  2: "bg-orange-500",
  3: "bg-blue-600",
  4: "bg-amber-500",
  5: "bg-muted-foreground",
};

export function bucketSwatchClass(bucket: number) {
  return BUCKET_SWATCHES[bucket] ?? "bg-muted-foreground";
}

/** "01:00" in the zone. */
export function formatClock(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(ms);
}

/** "14 Jul", with the year when it isn't this year's. */
export function formatDay(ms: number, timeZone: string, now = Date.now()) {
  const year = (value: number) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: year(ms) === year(now) ? undefined : "numeric",
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

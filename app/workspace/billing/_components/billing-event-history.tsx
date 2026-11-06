"use client";

import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
import type { BillingPaymentStatus } from "@/convex/billing/types";
import { cn } from "@/lib/utils";
import type { BillingPaymentDetail } from "./billing-payment-facts";
import { FIGURE, formatPaidAt, PAYMENT_TYPE_LABELS, plural, STATUS_LABELS } from "./billing-format";

// The payment's history as ruled rows: when, what happened, who.

type BillingPaymentEvent = BillingPaymentDetail["events"][number];

/** WHEN · WHAT · WHO, folding WHO under WHAT in a narrow card. */
export const HISTORY_COLUMNS =
  "grid grid-cols-[7.25rem_minmax(0,1fr)] gap-x-4 gap-y-1 @xl/history:grid-cols-[7.25rem_minmax(0,1fr)_minmax(0,11rem)]";

function statusWord(value: string) {
  return value in STATUS_LABELS ? STATUS_LABELS[value as BillingPaymentStatus] : value;
}

function eventDetail(event: BillingPaymentEvent) {
  if (event.eventType === "payment.verified") return "Moved from Needs review to Reviewed.";
  if (event.fromStatus && event.toStatus) return `${statusWord(event.fromStatus)} → ${statusWord(event.toStatus)}`;
  if (event.toStatus) return `Set to ${statusWord(event.toStatus)}`;
  return event.reason ?? null;
}

function parseEventMetadata(metadata: string | null) {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const FIELD_LABELS: Record<string, string> = {
  amountMinor: "Amount",
  paymentType: "Payment type",
  programId: "Program ID",
  programName: "Program",
  referenceCode: "Reference",
  note: "Internal note",
};

function formatValue(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "number") return key === "amountMinor" ? (value / 100).toFixed(2) : String(value);
  if (key === "paymentType" && typeof value === "string" && value in PAYMENT_TYPE_LABELS) {
    return PAYMENT_TYPE_LABELS[value as keyof typeof PAYMENT_TYPE_LABELS];
  }
  return String(value);
}

/** Codes in mono, amounts in condensed figures, words as words. */
function valueClass(key: string) {
  if (key === "referenceCode" || key === "programId") return "font-mono text-[12.5px]";
  if (key === "amountMinor") return "font-condensed text-[14px] font-semibold tabular-nums";
  return "";
}

function CorrectionChanges({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([key]) => key !== "returnedToReview");
  if (entries.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-[13px] text-muted-foreground">
      {entries.map(([key, value]) => {
        const change = value && typeof value === "object" ? (value as { from?: unknown; to?: unknown }) : { from: null, to: value };
        return (
          <li key={key}>
            <span className="font-medium text-foreground">{FIELD_LABELS[key] ?? key}</span>{" "}
            <span className={valueClass(key)}>{formatValue(key, change.from)}</span> →{" "}
            <span className={cn(valueClass(key), "text-foreground")}>{formatValue(key, change.to)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function sentence(verb: string) {
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

export function BillingEventHistory({ events, now }: { events: BillingPaymentEvent[]; now: number }) {
  return (
    <DetailCard title="History" meta={events.length > 0 ? plural(events.length, "event") : null}>
      {events.length === 0 ? (
        <SectionEmpty title="No history yet.">Events appear here as the payment is recorded, reviewed or corrected.</SectionEmpty>
      ) : (
        <ol className="@container/history">
          {events.map((event) => {
            const detail = eventDetail(event);
            const metadata = event.eventType === "payment.corrected" ? parseEventMetadata(event.metadata) : null;
            return (
              <li key={event.id} className={cn(HISTORY_COLUMNS, "min-h-11 items-baseline border-b px-4 py-2.5 last:border-b-0")}>
                <time dateTime={new Date(event.occurredAt).toISOString()} className={FIGURE}>
                  {formatPaidAt(event.occurredAt, now)}
                </time>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{sentence(getEventLabel(event.eventType).verb)}</span>
                    <span className="font-condensed text-[12px] font-bold tracking-[0.08em] text-muted-foreground uppercase">
                      {event.source}
                    </span>
                  </p>
                  {detail ? <p className="text-[13px] text-muted-foreground">{detail}</p> : null}
                  {event.reason && event.reason !== detail ? (
                    <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">“{event.reason}”</p>
                  ) : null}
                  {metadata ? <CorrectionChanges metadata={metadata} /> : null}
                </div>
                <div className="col-start-2 min-w-0 text-[13px] text-muted-foreground @xl/history:col-start-3">
                  {event.actor ? (
                    <MemberIdentity identity={event.actor} className="gap-2" textClassName="[&>p]:hidden [&_span]:font-normal" />
                  ) : (
                    <span>{event.actorName ?? "System"}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </DetailCard>
  );
}

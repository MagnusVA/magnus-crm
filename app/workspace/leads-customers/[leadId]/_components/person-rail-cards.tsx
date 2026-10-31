"use client";

import type { AttributionTouch } from "@/convex/lib/attribution/detailPayload";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { INITIAL_SOURCE_META } from "@/app/workspace/_components/initial-source-badge";
import { TOUCH_CHANNEL_LABELS } from "@/app/workspace/_components/deal-stage-track";
import { useEntityDetail } from "./entity-detail-context";
import { personDate } from "./person-format";

const NUMBER = /^[\d\s.,$€£%+-]+$/;

/** What the person answered when they booked, question over answer, one ruled row each. */
export function BookingAnswersCard() {
  const { lead } = useEntityDetail();
  const answers = Object.entries(lead.customFields ?? {}).filter(([, value]) => value.trim() !== "");

  return (
    <DetailCard title="Booking answers">
      {answers.length === 0 ? (
        <SectionEmpty title="No booking answers.">
          They appear when the person books through Calendly.
        </SectionEmpty>
      ) : (
        <dl className="divide-y">
          {answers.map(([key, value]) => (
            <div key={key} className="px-4 py-2.5">
              <dt className="text-[0.8125rem] text-muted-foreground">
                {lead.customFieldLabels?.[key] ?? key}
              </dt>
              <dd
                className={
                  NUMBER.test(value)
                    ? "mt-0.5 font-condensed text-base leading-tight font-semibold tabular-nums"
                    : "mt-0.5 text-sm wrap-break-word"
                }
                translate="no"
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </DetailCard>
  );
}

/** Where the person came from: their first and latest touch, and what the DM portal recorded. */
export function SourceCard() {
  const { lead, firstTouch, latestTouch } = useEntityDetail();
  const initialSource = lead.initialSource ? INITIAL_SOURCE_META[lead.initialSource].label : null;
  const income = lead.selfReportedIncome;

  return (
    <DetailCard title="Source">
      <dl className="divide-y">
        <SourceRow label="First touch">
          <TouchValue touch={firstTouch} />
        </SourceRow>
        {latestTouch && latestTouch.eventId !== firstTouch?.eventId ? (
          <SourceRow label="Latest touch">
            <TouchValue touch={latestTouch} />
          </SourceRow>
        ) : null}
        {initialSource ? <SourceRow label="Initial source">{initialSource}</SourceRow> : null}
        {income !== undefined ? (
          <SourceRow label="Income">
            <span className="font-condensed text-base font-semibold tabular-nums">
              {new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(income)}
            </span>
            <span className="block text-[0.8125rem] font-normal text-muted-foreground">
              Self-reported in the DM portal
            </span>
          </SourceRow>
        ) : null}
      </dl>
    </DetailCard>
  );
}

function SourceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.25rem_minmax(0,1fr)] gap-x-2.5 px-4 py-2.5">
      <dt className="pt-px text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}

function TouchValue({ touch }: { touch: AttributionTouch | null }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  if (!touch) return <span className="font-normal text-muted-foreground">Not recorded</span>;
  return (
    <>
      <span className="wrap-break-word" translate="no">
        {TOUCH_CHANNEL_LABELS[touch.channel]}
        {touch.teamMemberName ? ` · ${touch.teamMemberName}` : ""}
      </span>
      <span
        className="block font-condensed text-[0.8125rem] font-semibold tracking-[0.02em] text-muted-foreground tabular-nums"
        suppressHydrationWarning
      >
        {personDate(touch.occurredAt, setting, now)}
      </span>
    </>
  );
}

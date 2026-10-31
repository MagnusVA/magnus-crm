"use client";

import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { TOUCH_CHANNEL_LABELS } from "@/app/workspace/_components/deal-stage-track";
import { useEntityDetail } from "./entity-detail-context";
import { contactKey, personDate } from "./person-format";

const NUMBER = /^[\d\s.,$€£%+-]+$/;

/**
 * What the person answered when they booked, question over answer. Answers
 * that only repeat a contact value the person card shows (a phone, an
 * email, a handle) are left out.
 */
export function BookingAnswersCard() {
  const { lead, firstTouch } = useEntityDetail();
  const { setting } = useBusinessDay();
  const now = useNow();
  const contacts = new Set(
    [lead.phone, lead.email, ...(lead.socialHandles ?? []).map((handle) => handle.handle)]
      .filter((value): value is string => Boolean(value))
      .map(contactKey),
  );
  const answers = Object.entries(lead.customFields ?? {}).filter(
    ([, value]) => value.trim() !== "" && !contacts.has(contactKey(value)),
  );
  const booked = firstTouch?.channel === "calendly" ? firstTouch : null;

  return (
    <DetailCard
      title="Booking answers"
      meta={
        booked ? (
          <span suppressHydrationWarning>
            {TOUCH_CHANNEL_LABELS.calendly} ·{" "}
            <span className="font-condensed text-sm font-semibold tabular-nums">
              {personDate(booked.occurredAt, setting, now)}
            </span>
          </span>
        ) : null
      }
    >
      {answers.length === 0 ? (
        <SectionEmpty title="No booking answers.">
          They appear when the person books through Calendly.
        </SectionEmpty>
      ) : (
        <dl className="divide-y">
          {answers.map(([key, value]) => (
            <div key={key} className="px-4 py-2">
              <dt className="text-[0.8125rem] text-muted-foreground">
                {lead.customFieldLabels?.[key] ?? key}
              </dt>
              <dd
                className={
                  NUMBER.test(value)
                    ? "font-condensed text-base leading-tight font-semibold tabular-nums"
                    : "text-sm wrap-break-word"
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

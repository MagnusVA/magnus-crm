"use client";

import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import type { BillingPaymentDetail } from "./billing-payment-facts";
import { FIGURE, formatPaidAt, plural } from "./billing-format";

// Who qualified the lead in Slack, one dense row each: when, who, result.
// One line at any width; the Slack user ID shows once the card has room.

const SLACK_COLUMNS =
  "grid grid-cols-[6.5rem_minmax(0,1fr)_auto] gap-x-3 @xl/history:grid-cols-[7.25rem_minmax(0,1fr)_minmax(0,11rem)] @xl/history:gap-x-4";

type SlackContributorEvent = BillingPaymentDetail["slackContributorTimeline"][number];

const RESULT_WORDS: Record<NonNullable<SlackContributorEvent["resultKind"]>, string> = {
  created_opportunity: "Created deal",
  duplicate_pending: "Duplicate",
  already_booked: "Already booked",
  unlinked: "Not linked",
};

export function SlackContributorTimeline({ events, now }: { events: SlackContributorEvent[]; now: number }) {
  return (
    <DetailCard
      title={
        <HelpTip tip="Setters who qualified this lead in Slack. The export's Slack contributor is the first of them.">
          Slack contributors
        </HelpTip>
      }
      meta={events.length > 0 ? plural(events.length, "entry", "entries") : null}
    >
      {events.length === 0 ? (
        <SectionEmpty title="No Slack qualifications.">No linked Slack qualification events were found for this lead.</SectionEmpty>
      ) : (
        <ol className="@container/history">
          {events.map((event) => (
            <li
              key={`${event.slackUserId}-${event.submittedAt}`}
              className={cn(SLACK_COLUMNS, "min-h-9 items-center border-b px-4 py-1 last:border-b-0")}
            >
              <time dateTime={new Date(event.submittedAt).toISOString()} className={cn(FIGURE, "whitespace-nowrap")}>
                {formatPaidAt(event.submittedAt, now)}
              </time>
              <div className="flex min-w-0 items-center gap-3">
                <MemberIdentity identity={event.identity} className="min-w-0 gap-2" textClassName="[&>p]:hidden" />
                <span className="hidden shrink-0 font-mono text-[12px] text-muted-foreground @md/history:inline" translate="no">
                  {event.slackUserId}
                </span>
              </div>
              <span className="font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
                {event.resultKind ? RESULT_WORDS[event.resultKind] : "No result"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </DetailCard>
  );
}

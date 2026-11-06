"use client";

import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import type { BillingPaymentDetail } from "./billing-payment-facts";
import { HISTORY_COLUMNS } from "./billing-event-history";
import { FIGURE, formatPaidAt, plural } from "./billing-format";

// Who qualified the lead in Slack, in the history's rows.

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
              className={cn(HISTORY_COLUMNS, "min-h-11 items-center border-b px-4 py-2 last:border-b-0")}
            >
              <time dateTime={new Date(event.submittedAt).toISOString()} className={FIGURE}>
                {formatPaidAt(event.submittedAt, now)}
              </time>
              <div className="flex min-w-0 items-center gap-3">
                <MemberIdentity identity={event.identity} className="min-w-0 gap-2" textClassName="[&>p]:hidden" />
                <span className="hidden shrink-0 font-mono text-[12px] text-muted-foreground @md/history:inline" translate="no">
                  {event.slackUserId}
                </span>
              </div>
              <span className="col-start-2 font-condensed text-[13px] font-bold tracking-[0.08em] text-muted-foreground uppercase @xl/history:col-start-3">
                {event.resultKind ? RESULT_WORDS[event.resultKind] : "No result"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </DetailCard>
  );
}

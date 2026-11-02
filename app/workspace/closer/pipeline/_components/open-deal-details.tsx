"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { BusinessDaySetting } from "@/lib/businessDay";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dealCreditParts } from "@/app/workspace/_components/deal-stage-track";
import { SetNextStepButton } from "@/app/workspace/_components/set-next-step-button";
import { formatClock } from "@/app/workspace/closer/_components/today-time";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { attendanceOf } from "@/app/workspace/leads-customers/[leadId]/_components/person-deal-calls";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { dealHref } from "./deal-cells";

// An open deal opened in place in the list: its latest calls, how to reach
// the person, who is credited, the deal's note, and the deal's actions. It
// reads the deal modal's query, so it shows what the modal would.

const SHOWN_CALLS = 3;
const LABEL = "font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

export function OpenDealDetails({
  opportunityId,
  leadId,
  recordHref,
  now,
  setting,
}: {
  opportunityId: string;
  leadId: string;
  /** The meeting page of the call that passed with no result, if any. */
  recordHref: string | null;
  now: number;
  setting: BusinessDaySetting;
}) {
  const detail = useQuery(api.opportunities.detailQuery.getOpportunityDetail, {
    opportunityId: opportunityId as Id<"opportunities">,
  });

  if (detail === undefined) {
    // At the loaded panel's height, footer included, so the list doesn't jump.
    return (
      <div role="status" aria-label="Loading the deal" className="border-t bg-muted/30">
        <div className="grid gap-x-6 gap-y-3.5 px-4 pt-3 pb-3.5 @4xl/deals:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
        <div className="flex h-11 items-center justify-end gap-4 border-t px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <p className="border-t bg-muted/30 px-4 py-3 text-muted-foreground">
        This deal isn&apos;t yours any more, or it was removed.
      </p>
    );
  }

  const { lead, opportunity, nextStep } = detail;
  // Newest first.
  const calls = [...detail.meetings].sort((a, b) => b.scheduledAt - a.scheduledAt).slice(0, SHOWN_CALLS);
  const credits = dealCreditParts({ dealAttribution: detail.attribution, assignedCloser: detail.closer });
  const note = opportunity.notes?.trim() || null;
  const leadName = lead?.fullName ?? null;
  const taskHref = nextStep?.taskId ? `/workspace/closer/reminders/${nextStep.taskId}` : null;
  // The row knows the call behind the deal's next call; the deal's own calls
  // name any other that ended with no result.
  const unrecorded = calls.find((call) => attendanceOf(call, now).owed) ?? null;
  const recordOutcomeHref =
    recordHref ?? (unrecorded ? `/workspace/closer/meetings/${unrecorded._id}` : null);

  return (
    <div className="border-t bg-muted/30">
      <div className="grid gap-x-6 gap-y-3.5 px-4 pt-3 pb-3.5 @4xl/deals:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Calls">
          <h3 className={LABEL}>
            Calls{detail.meetings.length > 0 ? ` · ${detail.meetings.length}` : ""}
          </h3>
          {calls.length === 0 ? (
            <p className="mt-1 text-muted-foreground">No calls on this deal.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {calls.map((call) => {
                const attendance = attendanceOf(call, now);
                return (
                  <li key={call._id} className="flex items-baseline gap-2 leading-6">
                    <span className="font-condensed text-[15px] font-semibold tabular-nums">
                      {personDate(call.scheduledAt, setting, now)}
                    </span>
                    <span className="text-[13px] text-muted-foreground tabular-nums">
                      {formatClock(call.scheduledAt, setting.timeZone)} · {call.durationMinutes} min
                    </span>
                    <span
                      className={cn(
                        "font-condensed text-[13px] font-bold tracking-[0.08em] uppercase",
                        attendance.ink,
                      )}
                    >
                      {attendance.word}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Reach and credit">
          <h3 className={LABEL}>Reach by</h3>
          {lead?.phone || lead?.email ? (
            <p className="mt-1 flex flex-col leading-6" translate="no">
              {lead.phone ? (
                <span className="font-condensed text-[15px] tracking-[0.02em] tabular-nums">
                  {formatPhone(lead.phone)}
                </span>
              ) : null}
              {lead.email ? <span className="truncate">{lead.email}</span> : null}
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">No phone or email on file.</p>
          )}
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {credits.length === 0
              ? "No credit recorded."
              : credits.map((part, index) => (
                  <span key={part.key}>
                    {index > 0 ? " · " : null}
                    {part.role} <span className="font-semibold text-foreground">{part.name}</span>
                  </span>
                ))}
          </p>
        </section>

        <section aria-label="Note">
          <h3 className={LABEL}>Note</h3>
          <p className={cn("mt-1 line-clamp-4 leading-relaxed", note === null && "text-muted-foreground")}>
            {note ?? "No note on this deal."}
          </p>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t px-4 py-2">
        <Link href={dealHref(leadId, opportunityId)} className={detailLinkClass}>
          Open deal
        </Link>
        {taskHref ? (
          <Link href={taskHref} className={detailLinkClass}>
            Open task
          </Link>
        ) : null}
        {/* One lime action: recording the call that passed comes first. */}
        {recordOutcomeHref ? (
          <Button asChild size="sm">
            <Link href={recordOutcomeHref}>Record outcome</Link>
          </Button>
        ) : nextStep ? (
          <SetNextStepButton
            canSet={nextStep.canSet}
            opportunityId={opportunity._id}
            leadName={leadName}
          />
        ) : null}
      </div>
    </div>
  );
}

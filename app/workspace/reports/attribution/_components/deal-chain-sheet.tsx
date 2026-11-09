"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DealChain } from "@/convex/reports/attribution";
import { DEAL_POSITION_LABELS } from "@/convex/opportunities/stages";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { termHelp } from "@/lib/reporting/definitions";
import { meetingStatusConfig } from "@/lib/status-config";
import { cn } from "@/lib/utils";
import { FIGURE_15, LABEL, ReportNote, StatusWord, type StatusTone } from "../../_components/report-ui";
import { memberReportHref } from "../../log/_components/use-team-members";
import { formatMoney } from "../../scorecard/_components/report-money";
import { NOT_LINKED, ROLE_LABELS, SOURCE_LABELS } from "./attribution-shape";

// One deal's chain (§11): every credit row with its source and time and what
// it is credited for, every call with the closer it had at the time, and
// every payment. A live read, so the chain is as of now, not as of the range.

const PAYMENT_TYPE_LABELS: Record<string, string> = { pif: "Paid in full", split: "Split", monthly: "Monthly", deposit: "Deposit" };

const MEETING_TONE: Record<string, StatusTone> = { scheduled: "live", held: "done", canceled: "done", no_show: "failed" };

function when(at: number) {
  return format(at, "MMM d, yyyy · h:mm a");
}

/** The deal's stage in words: its outcome once it is closed. */
function dealStageWords(chain: Pick<DealChain, "stage" | "outcome">) {
  if (chain.outcome === "won") return DEAL_POSITION_LABELS.won;
  if (chain.outcome === "lost") return DEAL_POSITION_LABELS.lost;
  return (DEAL_POSITION_LABELS as Record<string, string>)[chain.stage] ?? chain.stage;
}

function MemberName({ identity }: { identity: { name: string; teamMemberId: Id<"teamMembers"> | null; linked: boolean } }) {
  return (
    <>
      {identity.teamMemberId ? (
        <Link href={memberReportHref(identity.teamMemberId)} className={detailLinkClass}>
          {identity.name}
        </Link>
      ) : (
        <span className="font-semibold">{identity.name}</span>
      )}
      {!identity.linked ? <span className="block text-[13px] text-muted-foreground">{NOT_LINKED}</span> : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b last:border-b-0">
      <h3 className={cn(LABEL, "border-b bg-muted/30 px-4 py-2")}>{title}</h3>
      {children}
    </section>
  );
}

export function DealChainSheet({
  opportunityId,
  onClose,
}: {
  opportunityId: Id<"opportunities"> | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={opportunityId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        {opportunityId ? (
          <SectionErrorBoundary key={opportunityId} sectionName="deal chain">
            <ChainBody opportunityId={opportunityId} />
          </SectionErrorBoundary>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ChainBody({ opportunityId }: { opportunityId: Id<"opportunities"> }) {
  const chain = useQuery(api.reports.attribution.getDealChain, { opportunityId });

  if (chain === undefined) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>Loading the deal</SheetTitle>
          <SheetDescription className="sr-only">Every credit, call and payment on one deal.</SheetDescription>
        </SheetHeader>
        <div role="status" aria-label="Loading the deal" className="flex flex-col gap-3 p-4">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>{chain.personName}</SheetTitle>
        <SheetDescription>
          {dealStageWords(chain)} · {chain.credits.length} credit{chain.credits.length === 1 ? "" : "s"} ·{" "}
          {chain.payments.length} payment{chain.payments.length === 1 ? "" : "s"}
        </SheetDescription>
        <Link href={`/workspace/opportunities/${chain.opportunityId}`} className={cn(detailLinkClass, "w-fit text-[13px]")}>
          Open deal
        </Link>
      </SheetHeader>
      {chain.isTruncated ? (
        <ReportNote lead="Partial.">This deal has more records than the panel reads at once.</ReportNote>
      ) : null}

      <Section title="Credits">
        {chain.credits.length === 0 ? (
          <SectionEmpty title="No one is credited on this deal." />
        ) : (
          <ul aria-label="Credits">
            {chain.credits.map((credit) => (
              <li key={credit.id} className="flex flex-col gap-1 border-b px-4 py-2.5 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className={LABEL}>{ROLE_LABELS[credit.role]}</p>
                  <time dateTime={new Date(credit.attributedAt).toISOString()} className="text-[13px] text-muted-foreground">
                    {when(credit.attributedAt)}
                  </time>
                </div>
                <div>
                  <MemberName identity={credit} />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  {SOURCE_LABELS[credit.sourceKind] ?? credit.sourceKind}
                  {credit.meetingId ? (
                    <>
                      {" · "}
                      <Link href={`/workspace/pipeline/meetings/${credit.meetingId}`} className={detailLinkClass}>
                        Open call
                      </Link>
                    </>
                  ) : null}
                </p>
                <p className="text-[13px]">
                  <HelpTip tip={termHelp("creditedCash")}>Credited for</HelpTip>{" "}
                  {credit.creditedFor.length === 0 ? (
                    <span className={cn(FIGURE_15, "text-muted-foreground")}>no payments yet</span>
                  ) : (
                    credit.creditedFor.map((row, index) => (
                      <span key={row.currency} className={cn(FIGURE_15, row.amountMinor === 0 && "text-muted-foreground")}>
                        {index > 0 ? " · " : null}
                        {formatMoney(row.amountMinor, row.currency)}
                      </span>
                    ))
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Calls">
        {chain.meetings.length === 0 ? (
          <SectionEmpty title="No calls on this deal." />
        ) : (
          <ul aria-label="Calls">
            {chain.meetings.map((meeting) => (
              <li key={meeting.id} className="flex flex-col gap-1 border-b px-4 py-2.5 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <Link href={`/workspace/pipeline/meetings/${meeting.id}`} className={cn(detailLinkClass, FIGURE_15)}>
                    {when(meeting.scheduledAt)}
                  </Link>
                  <StatusWord tone={MEETING_TONE[meeting.status] ?? "done"}>
                    {(meetingStatusConfig as Record<string, { label: string }>)[meeting.status]?.label ?? meeting.status}
                  </StatusWord>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Closer at the time: <MemberName identity={meeting.closer} />
                </p>
                {meeting.moved || meeting.rebooked ? (
                  <p className="flex flex-wrap gap-3 text-[13px]">
                    {meeting.moved ? <HelpTip tip={termHelp("moved")}>Moved</HelpTip> : null}
                    {meeting.rebooked ? <HelpTip tip={termHelp("rebooked")}>Rebooked after a no-show</HelpTip> : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Payments">
        {chain.payments.length === 0 ? (
          <SectionEmpty title="No payments on this deal yet." />
        ) : (
          <ul aria-label="Payments">
            {chain.payments.map((payment) => (
              <li key={payment.id} className="flex flex-col gap-0.5 border-b px-4 py-2.5 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className={cn(FIGURE_15, payment.status === "disputed" && "text-muted-foreground line-through")}>
                    {formatMoney(payment.amountMinor, payment.currency)}
                  </p>
                  <time dateTime={new Date(payment.recordedAt).toISOString()} className="text-[13px] text-muted-foreground">
                    {when(payment.recordedAt)}
                  </time>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  {PAYMENT_TYPE_LABELS[payment.type] ?? payment.type}
                  {payment.status === "disputed" ? (
                    <>
                      {" · "}
                      <StatusWord tone="failed">Disputed</StatusWord>
                    </>
                  ) : null}
                  {payment.closer ? (
                    <>
                      {" · "}
                      {payment.closer.teamMemberId ? (
                        <Link href={memberReportHref(payment.closer.teamMemberId)} className={detailLinkClass}>
                          {payment.closer.name}
                        </Link>
                      ) : (
                        payment.closer.name
                      )}
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

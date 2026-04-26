"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import {
  ArrowLeftIcon,
  BellRingIcon,
  CalendarXIcon,
  MailIcon,
  PhoneIcon,
  UserRoundIcon,
} from "lucide-react";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { OpportunitySourceBadge } from "../../_components/opportunity-source-badge";
import { DeleteOpportunityDialog } from "./delete-opportunity-dialog";
import { MarkSideDealLostDialog } from "./mark-side-deal-lost-dialog";
import { OpportunityActivityTimeline } from "./opportunity-activity-timeline";
import { OpportunityDetailSkeleton } from "./opportunity-detail-skeleton";
import { OpportunityMeetingsList } from "./opportunity-meetings-list";
import { OpportunityPaymentsList } from "./opportunity-payments-list";
import { SideDealPaymentDialog } from "./side-deal-payment-dialog";
import { VoidPaymentDialog } from "./void-payment-dialog";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "Not recorded";
  }
  return dateTimeFormatter.format(new Date(timestamp));
}

function formatSource(source: "calendly" | "side_deal") {
  return source === "side_deal" ? "Side deal" : "Calendly";
}

export function OpportunityDetailClient({
  opportunityId,
}: {
  opportunityId: Id<"opportunities">;
}) {
  const data = useQuery(api.opportunities.detailQuery.getOpportunityDetail, {
    opportunityId,
  });

  usePageTitle(data?.lead?.fullName ?? data?.lead?.email ?? "Opportunity");

  if (data === undefined) {
    return <OpportunityDetailSkeleton />;
  }

  if (data === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Opportunity unavailable</CardTitle>
          <CardDescription>
            It may have been deleted, reassigned, or moved outside your access.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const {
    opportunity,
    lead,
    closer,
    meetings,
    payments,
    events,
    pendingStaleNudge,
    permissions,
  } = data;
  const isSideDeal = opportunity.source === "side_deal";
  const displayName = lead?.fullName ?? lead?.email ?? "Unknown lead";
  const meetingBasePath =
    permissions.viewerRole === "closer"
      ? "/workspace/closer/meetings"
      : "/workspace/pipeline/meetings";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/workspace/opportunities">
              <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
              Opportunities
            </Link>
          </Button>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <OpportunitySourceBadge source={opportunity.source} />
              <StatusBadge status={opportunity.status} />
              {lead?.status ? (
                <Badge variant="muted">Lead {lead.status}</Badge>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {permissions.canRecordPayment ? (
              <SideDealPaymentDialog opportunityId={opportunity._id} />
            ) : null}
            {permissions.canMarkLost ? (
              <MarkSideDealLostDialog opportunityId={opportunity._id} />
            ) : null}
            {permissions.canVoidPayment && permissions.voidablePaymentId ? (
              <VoidPaymentDialog paymentId={permissions.voidablePaymentId} />
            ) : null}
            {permissions.canDeleteOpportunity ? (
              <DeleteOpportunityDialog opportunityId={opportunity._id} />
            ) : null}
          </div>
        </div>
      </div>

      {pendingStaleNudge ? (
        <Alert>
          <BellRingIcon aria-hidden="true" />
          <AlertDescription>
            This side-deal opportunity has been sitting with no activity.
            Record payment, mark it lost, or delete it if it was created by
            mistake.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <SectionErrorBoundary sectionName="Opportunity summary">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              <CardDescription>
                Current ownership and lifecycle details for this opportunity.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <DetailField
                  label="Source"
                  value={formatSource(opportunity.source)}
                />
                <DetailField
                  label="Assigned closer"
                  value={closer?.fullName ?? closer?.email ?? "Unassigned"}
                />
                <DetailField
                  label="Created"
                  value={formatDateTime(opportunity.createdAt)}
                />
                <DetailField
                  label="Last activity"
                  value={formatDateTime(
                    opportunity.latestActivityAt ?? opportunity.updatedAt,
                  )}
                />
                <DetailField
                  label="Payment received"
                  value={formatDateTime(opportunity.paymentReceivedAt)}
                />
                <DetailField
                  label="Lost"
                  value={formatDateTime(opportunity.lostAt)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Notes
                </p>
                <p className="whitespace-pre-wrap text-sm">
                  {opportunity.notes?.trim() || "No notes recorded."}
                </p>
              </div>
              {opportunity.lostReason ? (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Lost reason
                  </p>
                  <p className="whitespace-pre-wrap text-sm">
                    {opportunity.lostReason}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Lead information">
          <Card>
            <CardHeader>
              <CardTitle>Lead</CardTitle>
            </CardHeader>
            <CardContent>
              {lead ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <UserRoundIcon
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {lead.fullName ?? lead.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {lead.status}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 text-sm">
                    <IconLine
                      icon={<MailIcon aria-hidden="true" />}
                      value={lead.email}
                    />
                    <IconLine
                      icon={<PhoneIcon aria-hidden="true" />}
                      value={lead.phone ?? "No phone recorded"}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Lead details are unavailable.
                </p>
              )}
            </CardContent>
          </Card>
        </SectionErrorBoundary>
      </div>

      <SectionErrorBoundary sectionName="Meetings">
        <Card>
          <CardHeader>
            <CardTitle>Meetings</CardTitle>
            <CardDescription>
              Calendly meetings linked to this opportunity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isSideDeal ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CalendarXIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No meetings</EmptyTitle>
                  <EmptyDescription>
                    This opportunity was created manually as a side deal and
                    has no Calendly meetings.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <OpportunityMeetingsList
                meetings={meetings}
                meetingBasePath={meetingBasePath}
              />
            )}
          </CardContent>
        </Card>
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="Payments">
        <OpportunityPaymentsList payments={payments} />
      </SectionErrorBoundary>

      <SectionErrorBoundary sectionName="Activity">
        <OpportunityActivityTimeline events={events} />
      </SectionErrorBoundary>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="truncate text-sm">{value}</p>
    </div>
  );
}

function IconLine({
  icon,
  value,
}: {
  icon: ReactNode;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <span className="[&>svg]:size-4">{icon}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

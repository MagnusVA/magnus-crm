"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ArrowLeftIcon, AlertCircleIcon, ShuffleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { LeadInfoPanel } from "../../_components/lead-info-panel";
import { MeetingInfoPanel } from "../../_components/meeting-info-panel";
import { MeetingNotes } from "../../_components/meeting-notes";
import { PaymentLinksPanel } from "../../_components/payment-links-panel";
import { OutcomeActionBar } from "../../_components/outcome-action-bar";
import { BookingAnswersCard } from "../../_components/booking-answers-card";
import { DealWonCard } from "../../_components/deal-won-card";
import { AttributionCard } from "../../_components/attribution-card";
import { PotentialDuplicateBanner } from "../../_components/potential-duplicate-banner";
import { NoShowActionBar } from "../../_components/no-show-action-bar";
import {
  RescheduleLinkDisplay,
  RescheduleLinkSentBanner,
} from "../../_components/reschedule-link-display";
import { RescheduleChainBanner } from "../../_components/reschedule-chain-banner";

type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  eventTypeName: string | null;
  paymentLinks: Array<{
    provider: string;
    label: string;
    url: string;
  }> | null;
  payments: Array<
    Doc<"paymentRecords"> & {
      proofFileUrl: string | null;
      proofFileContentType: string | null;
      proofFileSize: number | null;
      closerName: string | null;
    }
  >;
  potentialDuplicate: {
    _id: string;
    fullName?: string;
    email: string;
  } | null;
  reassignmentInfo: {
    reassignedFromCloserName: string;
    reassignedAt: number;
    reason: string;
  } | null;
  rescheduledFromMeeting: {
    _id: string;
    scheduledAt: number;
    status: string;
  } | null;
} | null;

export function MeetingDetailPageClient({
  preloadedDetail,
  allowOutOfWindowMeetingStart,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
  allowOutOfWindowMeetingStart: boolean;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ?? "Meeting");

  const refreshDetail = async () => {
    router.refresh();
  };

  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(null);

  if (detail === undefined) {
    return <MeetingDetailSkeleton />;
  }

  if (detail === null) {
    return <MeetingNotFound onBack={() => router.push("/workspace/closer")} />;
  }

  const {
    meeting,
    opportunity,
    lead,
    assignedCloser,
    meetingHistory,
    eventTypeName,
    paymentLinks,
    payments,
    potentialDuplicate,
    reassignmentInfo,
    rescheduledFromMeeting,
  } = detail;

  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <Badge variant="secondary" className={cn(statusCfg?.badgeClass)}>
          {statusCfg?.label ?? opportunity.status}
        </Badge>
      </div>

      {/* Feature E: Potential duplicate banner */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
          opportunityId={opportunity._id}
          currentLeadId={lead._id}
        />
      )}

      {/* Feature H: Reassignment info alert */}
      {reassignmentInfo && (
        <Alert className="mb-0">
          <ShuffleIcon className="size-4" />
          <AlertDescription>
            This meeting was reassigned to you from{" "}
            <span className="font-medium">
              {reassignmentInfo.reassignedFromCloserName}
            </span>{" "}
            on{" "}
            {format(
              new Date(reassignmentInfo.reassignedAt),
              "MMM d, h:mm a",
            )}{" "}
            — {reassignmentInfo.reason}
          </AlertDescription>
        </Alert>
      )}

      {/* Feature B: Reschedule chain banner */}
      {rescheduledFromMeeting && (
        <RescheduleChainBanner
          rescheduledFromMeeting={rescheduledFromMeeting}
        />
      )}

      {/* Feature B: No-Show Action Bar */}
      {opportunity.status === "no_show" && (
        <NoShowActionBar
          meeting={meeting}
          opportunity={opportunity}
          lead={lead}
          onStatusChanged={refreshDetail}
          onRescheduleLinkCreated={(url) => setRescheduleLinkUrl(url)}
        />
      )}

      {/* Feature B: Reschedule Link Display (survives NoShowActionBar unmount) */}
      {rescheduleLinkUrl && (
        <RescheduleLinkDisplay
          url={rescheduleLinkUrl}
          onDismiss={() => setRescheduleLinkUrl(null)}
        />
      )}

      {/* Feature B: Reschedule Link Sent Banner (closer returned to page) */}
      {opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl && (
        <RescheduleLinkSentBanner opportunityId={opportunity._id} />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="md:col-span-1">
          <LeadInfoPanel lead={lead} meetingHistory={meetingHistory} />
        </div>

        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <MeetingInfoPanel
            meeting={meeting}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
          />
          <BookingAnswersCard customFields={lead.customFields} />

          {/* Deal Won Card — only when opportunity is won with payments */}
          {opportunity.status === "payment_received" && payments.length > 0 && (
            <DealWonCard payments={payments} />
          )}

          {/* Attribution Card — always shown */}
          <AttributionCard
            opportunity={opportunity}
            meeting={meeting}
            meetingHistory={meetingHistory}
          />

          {/* Notes with outcome select */}
          <MeetingNotes
            meetingId={meeting._id}
            initialNotes={meeting.notes ?? ""}
            meetingOutcome={meeting.meetingOutcome}
          />

          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
      </div>

      <OutcomeActionBar
        meeting={meeting}
        opportunity={opportunity}
        payments={payments}
        onStatusChanged={refreshDetail}
        allowOutOfWindowMeetingStart={allowOutOfWindowMeetingStart}
      />
    </div>
  );
}

function MeetingNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Meeting Not Found</EmptyTitle>
          <EmptyDescription>
            This meeting doesn&apos;t exist or you don&apos;t have access to it.
          </EmptyDescription>
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Dashboard
          </Button>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function MeetingDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>

        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />  {/* Meeting Info */}
          <Skeleton className="h-32 rounded-xl" />  {/* Booking Answers */}
          <Skeleton className="h-36 rounded-xl" />  {/* Attribution */}
          <Skeleton className="h-52 rounded-xl" />  {/* Notes + Outcome */}
        </div>
      </div>

      <div className="flex gap-3 border-t pt-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-md" />
        ))}
      </div>
    </div>
  );
}

"use client";

import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  ArrowLeftIcon,
  AlertCircleIcon,
  ShuffleIcon,
  UserIcon,
} from "lucide-react";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

// Cross-import reusable display components from closer meeting detail
import { LeadInfoPanel } from "@/app/workspace/closer/meetings/_components/lead-info-panel";
import { MeetingInfoPanel } from "@/app/workspace/closer/meetings/_components/meeting-info-panel";
import { MeetingComments } from "@/app/workspace/closer/meetings/_components/meeting-comments";
import { PaymentLinksPanel } from "@/app/workspace/closer/meetings/_components/payment-links-panel";
import { BookingAnswersCard } from "@/app/workspace/closer/meetings/_components/booking-answers-card";
import { DealWonCard } from "@/app/workspace/closer/meetings/_components/deal-won-card";
import { AttributionCard } from "@/app/workspace/closer/meetings/_components/attribution-card";
import { PotentialDuplicateBanner } from "@/app/workspace/closer/meetings/_components/potential-duplicate-banner";
import {
  RescheduleLinkDisplay,
  RescheduleLinkSentBanner,
} from "@/app/workspace/closer/meetings/_components/reschedule-link-display";
import { RescheduleChainBanner } from "@/app/workspace/closer/meetings/_components/reschedule-chain-banner";
import { FathomLinkField } from "@/app/workspace/closer/meetings/_components/fathom-link-field";
import { AdminActionBar } from "@/app/workspace/pipeline/meetings/_components/admin-action-bar";

type MeetingDetailData = FunctionReturnType<
  typeof api.closer.meetingDetail.getMeetingDetail
>;

export function AdminMeetingDetailClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ? `${detail.lead.fullName} — Admin` : "Meeting");

  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(
    null,
  );

  if (detail === undefined) {
    return <AdminMeetingDetailSkeleton />;
  }

  if (detail === null) {
    return (
      <MeetingNotFound onBack={() => router.push("/workspace/pipeline")} />
    );
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
      {/* Header: Back to pipeline + status badge */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/pipeline">
            <ArrowLeftIcon data-icon="inline-start" />
            Pipeline
          </Link>
        </Button>
        <Badge variant="secondary" className={cn(statusCfg?.badgeClass)}>
          {statusCfg?.label ?? opportunity.status}
        </Badge>
      </div>

      {/* Assigned closer info — prominent for admins */}
      {assignedCloser && (
        <Alert className="mb-0">
          <UserIcon className="size-4" />
          <AlertDescription>
            Assigned to{" "}
            <span className="font-medium">
              {assignedCloser.fullName ?? assignedCloser.email}
            </span>
            {assignedCloser.fullName && (
              <span className="text-muted-foreground">
                {" "}
                ({assignedCloser.email})
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

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
            This meeting was reassigned from{" "}
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

      {/* Feature B: Reschedule Link Display (survives action bar interactions) */}
      {rescheduleLinkUrl && (
        <RescheduleLinkDisplay
          url={rescheduleLinkUrl}
          onDismiss={() => setRescheduleLinkUrl(null)}
        />
      )}

      {/* Feature B: Reschedule Link Sent Banner */}
      {opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl && (
        <RescheduleLinkSentBanner opportunityId={opportunity._id} />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="md:col-span-1">
          <LeadInfoPanel
            lead={lead}
            meetingHistory={meetingHistory}
            meetingDetailBasePath="/workspace/pipeline/meetings"
          />
        </div>

        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <MeetingInfoPanel
            meeting={meeting}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
          />
          <BookingAnswersCard customFields={lead.customFields} />

          {/* Deal Won Card — only when opportunity is won with payments */}
          {opportunity.status === "payment_received" &&
            payments.length > 0 && <DealWonCard payments={payments} />}

          {/* Attribution Card */}
          <AttributionCard
            opportunity={opportunity}
            meeting={meeting}
            meetingHistory={meetingHistory}
          />

          {/* v2: Fathom Recording link — admin can save/update for any
              meeting. Same component as closer side (backend authorizes
              both roles). */}
          <FathomLinkField
            meetingId={meeting._id}
            initialLink={meeting.fathomLink ?? ""}
            savedAt={meeting.fathomLinkSavedAt}
          />

          {/* Comments */}
          <MeetingComments meetingId={meeting._id} />

          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
      </div>

      {/* Admin Action Bar — contextual actions based on opportunity status */}
      <AdminActionBar
        meeting={meeting}
        opportunity={opportunity}
        payments={payments}
        onRescheduleLinkCreated={(url) => setRescheduleLinkUrl(url)}
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
            This meeting doesn&apos;t exist or you don&apos;t have access to
            it.
          </EmptyDescription>
          <Button variant="outline" onClick={onBack} className="mt-4">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Pipeline
          </Button>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function AdminMeetingDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-28" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>

        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </div>
      </div>

      <div className="flex gap-3 border-t pt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-md" />
        ))}
      </div>
    </div>
  );
}

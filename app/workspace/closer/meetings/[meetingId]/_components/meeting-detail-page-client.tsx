"use client";

import type { FunctionReturnType } from "convex/server";
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
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  ArrowLeftIcon,
  AlertCircleIcon,
  ShuffleIcon,
  TrophyIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { MeetingOverviewCard } from "../../_components/meeting-overview-card";
import { MeetingHistoryCard } from "../../_components/meeting-history-card";
import { MeetingComments } from "../../_components/meeting-comments";
import { PaymentLinksPanel } from "../../_components/payment-links-panel";
import { OutcomeActionBar } from "../../_components/outcome-action-bar";
import { BookingAnswersCard } from "../../_components/booking-answers-card";
import { DealWonCard } from "../../_components/deal-won-card";
import { PotentialDuplicateBanner } from "../../_components/potential-duplicate-banner";
import { NoShowActionBar } from "../../_components/no-show-action-bar";
import {
  RescheduleLinkDisplay,
  RescheduleLinkSentBanner,
} from "../../_components/reschedule-link-display";
import { RescheduleChainBanner } from "../../_components/reschedule-chain-banner";
import { FathomLinkField } from "../../_components/fathom-link-field";

type MeetingDetailData = FunctionReturnType<
  typeof api.closer.meetingDetail.getMeetingDetail
>;

export function MeetingDetailPageClient({
  preloadedDetail,
  viewerRole,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
  viewerRole: Doc<"users">["role"];
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ?? "Meeting");

  const refreshDetail = async () => {
    router.refresh();
  };

  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(null);
  const [showDealWon, setShowDealWon] = useState(false);

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
    activeFollowUp,
    attributionTeam,
    dmCloser,
    assignedCloserIdentity,
    dmCloserIdentity,
  } = detail;

  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];
  const outcomeActionBarPayments = payments.map((payment) => ({
    ...payment,
    attributedCloserId: payment.attributedCloserId ?? undefined,
  })) as Doc<"paymentRecords">[];

  const isDealWon =
    opportunity.status === "payment_received" && payments.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Command header: identity + status (left), actions (right) ───── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 shrink-0"
            onClick={() => router.back()}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <h1 className="min-w-0 truncate text-base font-semibold" title={lead.fullName ?? undefined}>
            {lead.fullName ?? "Meeting"}
          </h1>
          <Badge
            variant="secondary"
            className={cn("shrink-0", statusCfg?.badgeClass)}
          >
            {statusCfg?.label ?? opportunity.status}
          </Badge>
        </div>

        {/* Actions — top-right, horizontal, packed */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isDealWon && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDealWon(true)}
              className="border-emerald-200 bg-emerald-50/50 text-emerald-700 hover:bg-emerald-100/80 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400"
            >
              <TrophyIcon data-icon="inline-start" />
              Deal Won
            </Button>
          )}
          <OutcomeActionBar
            meeting={meeting}
            opportunity={opportunity}
            viewerRole={viewerRole}
            payments={outcomeActionBarPayments}
            activeFollowUp={activeFollowUp}
            onStatusChanged={refreshDetail}
            compact
          />
        </div>
      </div>

      {/* ── Banners & alerts ────────────────────────────────────────────── */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
          opportunityId={opportunity._id}
          currentLeadId={lead._id}
        />
      )}

      {reassignmentInfo && (
        <Alert className="py-2">
          <ShuffleIcon className="size-4" />
          <AlertDescription className="text-sm">
            Reassigned from{" "}
            <span className="font-medium">
              {reassignmentInfo.reassignedFromCloserName}
            </span>{" "}
            on {format(new Date(reassignmentInfo.reassignedAt), "MMM d, h:mm a")} —{" "}
            {reassignmentInfo.reason}
          </AlertDescription>
        </Alert>
      )}

      {rescheduledFromMeeting && (
        <RescheduleChainBanner rescheduledFromMeeting={rescheduledFromMeeting} />
      )}

      {viewerRole === "closer" && opportunity.status === "no_show" && (
        <NoShowActionBar
          meeting={meeting}
          opportunity={opportunity}
          lead={lead}
          onStatusChanged={refreshDetail}
          onRescheduleLinkCreated={(url) => setRescheduleLinkUrl(url)}
        />
      )}

      {rescheduleLinkUrl && (
        <RescheduleLinkDisplay
          url={rescheduleLinkUrl}
          onDismiss={() => setRescheduleLinkUrl(null)}
        />
      )}

      {opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl && (
        <RescheduleLinkSentBanner opportunityId={opportunity._id} />
      )}

      {/* ── Workspace: single column md–xl, 3 columns at xl+ ───────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Column 1 — lead, meeting, attribution, history */}
        <div className="flex min-w-0 flex-col gap-4">
          <MeetingOverviewCard
            lead={lead}
            meeting={meeting}
            opportunity={opportunity}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
            assignedCloserIdentity={assignedCloserIdentity}
            attributionTeam={attributionTeam}
            dmCloser={dmCloser}
            dmCloserIdentity={dmCloserIdentity}
          />
          <MeetingHistoryCard meetingHistory={meetingHistory} />
        </div>

        {/* Column 2 — booking context */}
        <div className="flex min-w-0 flex-col gap-4">
          <BookingAnswersCard customFields={lead.customFields} />
          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>

        {/* Column 3 — recording + conversation */}
        <div className="flex min-w-0 flex-col gap-4">
          <FathomLinkField
            meetingId={meeting._id}
            initialLink={meeting.fathomLink ?? ""}
            savedAt={meeting.fathomLinkSavedAt}
          />
          <MeetingComments meetingId={meeting._id} />
        </div>
      </div>

      {/* ── Deal Won modal ──────────────────────────────────────────────── */}
      {isDealWon && (
        <Dialog open={showDealWon} onOpenChange={setShowDealWon}>
          <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto p-0">
            {/* DialogTitle required for a11y; DealWonCard provides the visual header */}
            <DialogTitle className="sr-only">Deal Won Details</DialogTitle>
            <DealWonCard payments={payments} />
          </DialogContent>
        </Dialog>
      )}
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
    <div className="flex flex-col gap-4" role="status" aria-label="Loading meeting details">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

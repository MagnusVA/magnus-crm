"use client";

import { useState } from "react";
import { format } from "date-fns";
import { ShuffleIcon } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useNow } from "@/hooks/use-now";
import { useOutcomeEligibility } from "@/hooks/use-outcome-eligibility";
import { formatCurrency } from "@/lib/format-currency";
import { isAwaitingOutcome, isDealWon } from "@/lib/deal-controls";
import { CallStrip } from "./call-strip";
import { DealCard } from "./deal-card";
import { DealWonCard } from "./deal-won-card";
import { FathomLinkField } from "./fathom-link-field";
import { MeetingComments } from "./meeting-comments";
import { OutcomeSection } from "./outcome-section";
import { PaymentLinksPanel } from "./payment-links-panel";
import { PersonCard } from "./person-card";
import { PotentialDuplicateBanner } from "./potential-duplicate-banner";
import { PrepCard } from "./prep-card";
import { RescheduleChainBanner } from "./reschedule-chain-banner";
import type { MeetingDetail, MeetingDetailMode } from "./meeting-detail-types";

type MeetingDetailViewProps = {
  detail: MeetingDetail;
  mode: MeetingDetailMode;
  viewerRole: Doc<"users">["role"];
  onStatusChanged?: () => Promise<void>;
};

/** "Booked via Calendly · Intro call · Rescheduled". */
function bookedViaLine(detail: MeetingDetail): string {
  const { meeting, eventTypeName } = detail;
  const parts = ["Booked via Calendly"];
  if (eventTypeName) parts.push(eventTypeName);
  if (meeting.rescheduledFromMeetingId) parts.push("Rescheduled");
  else if (meeting.callClassification === "follow_up") parts.push("Follow-up call");
  return parts.join(" · ");
}

/** The amount paid on a won deal, when every payment is in one currency. */
function paidValue(detail: MeetingDetail): string | null {
  const { opportunity, payments } = detail;
  if (!isDealWon(opportunity) || payments.length === 0) return null;
  const currency = payments[0].currency;
  if (payments.some((payment) => payment.currency !== currency)) return null;
  const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
  return formatCurrency(total, currency);
}

/**
 * The meeting page, shared by the closer's page and the admin twin: the call
 * as a board row, the outcome question, prep and comments on the left, and
 * the deal, the person and the recording on the right. `mode` picks which
 * mutations the outcome actions call.
 */
export function MeetingDetailView({
  detail,
  mode,
  viewerRole,
  onStatusChanged,
}: MeetingDetailViewProps) {
  const now = useNow();
  const eligible = useOutcomeEligibility(detail.meeting);
  const [showPayments, setShowPayments] = useState(false);
  const {
    meeting,
    opportunity,
    lead,
    potentialDuplicate,
    reassignmentInfo,
    rescheduledFromMeeting,
    paymentLinks,
    payments,
    activeFollowUp,
  } = detail;
  const meetingDetailBasePath =
    mode === "admin" ? "/workspace/pipeline/meetings" : "/workspace/closer/meetings";

  // Before the outcome window opens, prep comes first.
  const beforeCall =
    meeting.status === "scheduled" &&
    isAwaitingOutcome(opportunity) &&
    activeFollowUp === null &&
    viewerRole === "closer" &&
    !eligible;
  const dealWon = isDealWon(opportunity) && payments.length > 0;

  const outcome = (
    <OutcomeSection
      mode={mode}
      viewerRole={viewerRole}
      detail={detail}
      eligible={eligible}
      onStatusChanged={onStatusChanged}
      onShowPayments={() => setShowPayments(true)}
    />
  );
  const prep = <PrepCard leadId={lead._id} answers={detail.bookingAnswers} />;

  return (
    <div className="flex flex-col gap-3.5">
      <CallStrip
        meeting={meeting}
        now={now}
        leadName={lead.fullName ?? lead.email ?? "Unknown person"}
        bookedVia={bookedViaLine(detail)}
        programName={
          meeting.bookingProgramName ?? opportunity.firstBookingProgramName ?? null
        }
        programValue={paidValue(detail)}
      />

      {potentialDuplicate ? (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
          opportunityId={opportunity._id}
          currentLeadId={lead._id}
        />
      ) : null}

      {reassignmentInfo ? (
        <Alert className="py-2">
          <ShuffleIcon className="size-4" aria-hidden />
          <AlertDescription>
            Reassigned from{" "}
            <span className="font-medium text-foreground">
              {reassignmentInfo.reassignedFromCloserName}
            </span>{" "}
            on {format(new Date(reassignmentInfo.reassignedAt), "MMM d, h:mm a")}:{" "}
            {reassignmentInfo.reason}
          </AlertDescription>
        </Alert>
      ) : null}

      {rescheduledFromMeeting ? (
        <RescheduleChainBanner
          rescheduledFromMeeting={rescheduledFromMeeting}
          meetingDetailBasePath={meetingDetailBasePath}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_24rem] lg:gap-5">
        <div className="flex min-w-0 flex-col gap-3.5">
          {beforeCall ? (
            <>
              {prep}
              {outcome}
            </>
          ) : (
            <>
              {outcome}
              {prep}
            </>
          )}
          {paymentLinks && paymentLinks.length > 0 ? (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          ) : null}
          <MeetingComments meetingId={meeting._id} />
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          <DealCard detail={detail} />
          <PersonCard detail={detail} />
          <FathomLinkField
            meetingId={meeting._id}
            initialLink={meeting.fathomLink ?? ""}
            savedAt={meeting.fathomLinkSavedAt}
          />
        </div>
      </div>

      {dealWon ? (
        <Dialog open={showPayments} onOpenChange={setShowPayments}>
          <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto p-0">
            <DialogTitle className="sr-only">Payment details</DialogTitle>
            <DealWonCard payments={payments} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

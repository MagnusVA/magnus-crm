"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ExternalLinkIcon, UserXIcon } from "lucide-react";
import { useOutcomeEligibility } from "@/hooks/use-outcome-eligibility";

const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const MarkNoShowDialog = dynamic(() =>
  import("./mark-no-show-dialog").then((m) => ({
    default: m.MarkNoShowDialog,
  })),
);
const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type ActiveFollowUpSummary = {
  _id: Id<"followUps">;
  type: Doc<"followUps">["type"];
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  viewerRole: Doc<"users">["role"];
  payments: Doc<"paymentRecords">[];
  activeFollowUp?: ActiveFollowUpSummary | null;
  onStatusChanged?: () => Promise<void>;
  /** Render as a compact horizontal toolbar instead of a vertical card */
  compact?: boolean;
};

export function OutcomeActionBar({
  meeting,
  opportunity,
  viewerRole,
  activeFollowUp = null,
  onStatusChanged,
  compact = false,
}: OutcomeActionBarProps) {
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const viewerIsCloser = viewerRole === "closer";
  const isAdmin =
    viewerRole === "tenant_master" || viewerRole === "tenant_admin";
  const eligible = useOutcomeEligibility(meeting);
  const joinUrl = meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;
  const isNoShow = opportunity.status === "no_show";
  const hasActiveFollowUp = activeFollowUp !== null;
  const canRecordScheduledOutcome =
    meeting.status === "scheduled" &&
    opportunity.status === "scheduled" &&
    (viewerIsCloser || isAdmin) &&
    (isAdmin || eligible) &&
    !hasActiveFollowUp;

  if (isNoShow || (!joinUrl && !canRecordScheduledOutcome)) {
    return null;
  }

  // ── Compact horizontal toolbar ───────────────────────────────────────────
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {joinUrl ? (
          <Button asChild variant="outline" size="sm">
            <a href={joinUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon data-icon="inline-start" />
              Join Meeting
            </a>
          </Button>
        ) : null}

        {canRecordScheduledOutcome ? (
          <>
            <PaymentFormDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
              compact
            />
            <FollowUpDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
              compact
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowNoShowDialog(true)}
            >
              <UserXIcon data-icon="inline-start" />
              Mark No-Show
            </Button>
            <MarkLostDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
              compact
            />
          </>
        ) : null}

        <MarkNoShowDialog
          open={showNoShowDialog}
          onOpenChange={setShowNoShowDialog}
          meetingId={meeting._id}
          onSuccess={onStatusChanged}
        />
      </div>
    );
  }

  // ── Original vertical card layout ────────────────────────────────────────
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 [&_button]:w-full">
        {joinUrl ? (
          <Button asChild variant="outline">
            <a href={joinUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon data-icon="inline-start" />
              Join Meeting
            </a>
          </Button>
        ) : null}

        {joinUrl && canRecordScheduledOutcome ? <Separator /> : null}

        {canRecordScheduledOutcome ? (
          <div className="flex flex-col gap-2">
            <PaymentFormDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />

            <FollowUpDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />

            <Separator />

            <Button variant="outline" onClick={() => setShowNoShowDialog(true)}>
              <UserXIcon data-icon="inline-start" />
              Mark No-Show
            </Button>
            <MarkNoShowDialog
              open={showNoShowDialog}
              onOpenChange={setShowNoShowDialog}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />

            <MarkLostDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

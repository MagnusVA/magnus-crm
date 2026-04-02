"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import { ArrowLeftIcon, AlertCircleIcon } from "lucide-react";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "../../_components/status-config";
import { LeadInfoPanel } from "../_components/lead-info-panel";
import { MeetingInfoPanel } from "../_components/meeting-info-panel";
import { MeetingNotes } from "../_components/meeting-notes";
import { PaymentLinksPanel } from "../_components/payment-links-panel";
import { OutcomeActionBar } from "../_components/outcome-action-bar";

/**
 * Meeting Detail Page — `/workspace/closer/meetings/[meetingId]`
 *
 * The closer's operational workspace for an individual meeting. Composed of:
 * - Lead context and meeting history (left column)
 * - Meeting details, Zoom link, event type (right column)
 * - Editable notes with debounced auto-save
 * - Payment links from event type config
 * - Outcome action buttons (Start, Log Payment, Follow-up, Mark Lost)
 *
 * A single Convex subscription (`getMeetingDetail`) provides all data with
 * real-time updates when any related record changes.
 */
export default function MeetingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = params.meetingId as Id<"meetings">;

  const detail = useQuery(api.closer.meetingDetail.getMeetingDetail, {
    meetingId,
  });

  // Loading — subscription resolving
  if (detail === undefined) {
    return <MeetingDetailSkeleton />;
  }

  // Defensive: the query handler throws on error so this is unlikely,
  // but provides a fallback if the return type ever changes.
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
  } = detail;

  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];

  return (
    <div className="flex flex-col gap-6">
      {/* Header: back button + opportunity status badge */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <Badge variant="secondary" className={cn(statusCfg?.badgeClass)}>
          {statusCfg?.label ?? opportunity.status}
        </Badge>
      </div>

      {/* Two-column layout: lead sidebar (1/4) | main content (3/4) */}
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
          <MeetingNotes
            meetingId={meeting._id}
            initialNotes={meeting.notes ?? ""}
          />
          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
      </div>

      {/* Outcome action bar */}
      <OutcomeActionBar
        meeting={meeting}
        opportunity={opportunity}
        payments={payments}
      />
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

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

// ─── Loading skeleton ────────────────────────────────────────────────────────

/**
 * Skeleton that mirrors the meeting detail layout to prevent layout shift
 * while the Convex subscription resolves.
 */
function MeetingDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>

      {/* Action bar */}
      <div className="flex gap-3 border-t pt-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-md" />
        ))}
      </div>
    </div>
  );
}

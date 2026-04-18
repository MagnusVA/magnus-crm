"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LinkIcon,
  MessageSquareIcon,
  ScanSearchIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const CLOSER_RESPONSE_LABELS: Record<string, string> = {
  forgot_to_press: "I forgot to press start -- I actually attended",
  did_not_attend: "I didn't attend this meeting",
};

const STATED_OUTCOME_LABELS: Record<string, string> = {
  sale_made: "Sale was made -- payment needs to be logged",
  follow_up_needed: "Lead wants to think about it -- needs follow-up",
  lead_not_interested: "Lead is not interested -- deal is lost",
  lead_no_show: "Lead didn't show up",
  other: "Other",
};

const RESOLUTION_LABELS: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-Up Scheduled",
  mark_no_show: "Marked as No-Show",
  mark_lost: "Marked as Lost",
  acknowledged: "Acknowledged",
  // v2: dispute resolution — admin reverted closer's action.
  disputed: "Disputed",
};

// ---------------------------------------------------------------------------
// FathomCard — compact card showing the recording link.
// ---------------------------------------------------------------------------

export function FathomCard({ meeting }: { meeting: Doc<"meetings"> }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LinkIcon className="size-4" aria-hidden />
          Fathom Recording
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {meeting.fathomLink ? (
          <div className="space-y-1">
            <a
              href={meeting.fathomLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 break-all text-primary underline-offset-4 hover:underline"
            >
              {meeting.fathomLink}
              <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
            </a>
            {meeting.fathomLinkSavedAt && (
              <p className="text-xs text-muted-foreground">
                Saved{" "}
                {format(
                  new Date(meeting.fathomLinkSavedAt),
                  "MMM d, yyyy 'at' h:mm a",
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
            <span className="font-medium">No Fathom link provided</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SystemDetectionCard — compact card for detection telemetry.
// ---------------------------------------------------------------------------

export function SystemDetectionCard({
  review,
  meeting,
  closerName,
  closerEmail,
}: {
  review: Doc<"meetingReviews">;
  meeting: Doc<"meetings">;
  closerName: string;
  closerEmail: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScanSearchIcon className="size-4" aria-hidden />
          System Detection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div>
          <span className="text-muted-foreground">Detected:</span>{" "}
          {format(new Date(review.createdAt), "MMM d, yyyy 'at' h:mm a")}
        </div>
        <div>
          <span className="text-muted-foreground">Meeting:</span>{" "}
          {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
          {" -- "}
          {format(
            new Date(meeting.scheduledAt + meeting.durationMinutes * 60_000),
            "h:mm a",
          )}{" "}
          ({meeting.durationMinutes} min)
        </div>
        <div>
          <span className="text-muted-foreground">Closer:</span>{" "}
          <span className="font-medium">{closerName}</span>
        </div>
        {closerEmail && (
          <div className="break-all text-xs text-muted-foreground">
            {closerEmail}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CloserResponseCard — only renders when the v1 closer response fields
// are populated. v2 reviews don't populate these, so we skip the card
// entirely for v2 flows (no "No response from closer" placeholder).
// ---------------------------------------------------------------------------

export function CloserResponseCard({
  review,
}: {
  review: Doc<"meetingReviews">;
}) {
  if (!review.closerResponse) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquareIcon className="size-4" aria-hidden />
          Closer Response (legacy v1)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Response:</span>
          <Badge variant="outline">
            {CLOSER_RESPONSE_LABELS[review.closerResponse] ??
              review.closerResponse}
          </Badge>
        </div>
        {review.closerRespondedAt && (
          <div>
            <span className="text-muted-foreground">Responded:</span>{" "}
            {format(
              new Date(review.closerRespondedAt),
              "MMM d, yyyy 'at' h:mm a",
            )}
          </div>
        )}
        {review.closerStatedOutcome && (
          <div>
            <span className="text-muted-foreground">Stated Outcome:</span>{" "}
            {STATED_OUTCOME_LABELS[review.closerStatedOutcome] ??
              review.closerStatedOutcome}
          </div>
        )}
        {review.estimatedMeetingDurationMinutes != null && (
          <div>
            <span className="text-muted-foreground">Estimated Duration:</span>{" "}
            ~{review.estimatedMeetingDurationMinutes} minutes
          </div>
        )}
        {review.closerNote && (
          <div className="mt-2 rounded-md bg-muted/50 p-3 text-sm italic">
            &ldquo;{review.closerNote}&rdquo;
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ResolutionCard — only renders once the review is resolved. Green for
// acknowledged, red for disputed.
// ---------------------------------------------------------------------------

export function ResolutionCard({
  review,
  resolverName,
}: {
  review: Doc<"meetingReviews">;
  resolverName: string | null;
}) {
  if (review.status !== "resolved" || !review.resolutionAction) {
    return null;
  }

  const isDisputed = review.resolutionAction === "disputed";

  return (
    <Card
      className={cn(
        isDisputed
          ? "border-red-200 dark:border-red-800/40"
          : "border-emerald-200 dark:border-emerald-800/40",
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle
          className={cn(
            "flex items-center gap-2 text-sm",
            isDisputed
              ? "text-red-800 dark:text-red-200"
              : "text-emerald-800 dark:text-emerald-200",
          )}
        >
          {isDisputed ? (
            <ShieldAlertIcon
              className="size-4 text-red-600 dark:text-red-400"
              aria-hidden
            />
          ) : (
            <CheckCircle2Icon
              className="size-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          )}
          Admin Resolution
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Action:</span>
          <Badge
            variant="outline"
            className={cn(
              isDisputed
                ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400"
                : "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400",
            )}
          >
            {RESOLUTION_LABELS[review.resolutionAction] ??
              review.resolutionAction}
          </Badge>
        </div>
        {review.resolvedAt && (
          <div>
            <span className="text-muted-foreground">Resolved:</span>{" "}
            {format(
              new Date(review.resolvedAt),
              "MMM d, yyyy 'at' h:mm a",
            )}
          </div>
        )}
        {resolverName && (
          <div>
            <span className="text-muted-foreground">By:</span> {resolverName}
          </div>
        )}
        {review.resolutionNote && (
          <div className="mt-2 rounded-md bg-muted/50 p-3 text-sm italic">
            &ldquo;{review.resolutionNote}&rdquo;
          </div>
        )}
      </CardContent>
    </Card>
  );
}

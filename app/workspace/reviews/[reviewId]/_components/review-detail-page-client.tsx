"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeftIcon,
  AlertCircleIcon,
  CalendarDaysIcon,
  ClockIcon,
  UserIcon,
  MailIcon,
  PhoneIcon,
  VideoIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  CloserResponseCard,
  FathomCard,
  ResolutionCard,
  SystemDetectionCard,
} from "./review-context-card";
import {
  ReviewResolutionActions,
  ReviewResolutionContext,
} from "./review-resolution-bar";
import { ReviewOutcomeCard } from "./review-outcome-card";

export function ReviewDetailPageClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.reviews.queries.getReviewDetail>;
}) {
  const detail = usePreloadedQuery(preloadedDetail);

  const leadName = detail?.lead?.fullName ?? detail?.lead?.email ?? "Unknown";
  usePageTitle(detail ? `Review -- ${leadName}` : "Review");

  if (detail === undefined) {
    return <ReviewDetailSkeleton />;
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Review Not Found</EmptyTitle>
            <EmptyDescription>
              This review doesn&apos;t exist or you don&apos;t have access to
              it.
            </EmptyDescription>
            <Button variant="outline" asChild className="mt-4">
              <Link href="/workspace/reviews">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to Reviews
              </Link>
            </Button>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const {
    review,
    meeting,
    opportunity,
    lead,
    closerName,
    closerEmail,
    resolverName,
    timesSetterName,
    // v2: active pending follow-up on this review's opportunity.
    activeFollowUp,
    // v2: outcome audit payload
    paymentRecords,
    lostByUserName,
    noShowByUserName,
  } = detail;

  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];
  const isPending = review.status === "pending";

  return (
    <div className="flex flex-col gap-4">
      {/* ─────────────────────────────────────────────────────────────────
          Header row — back button, title + status, action buttons.
          Action buttons are positioned on the right so an admin's eye
          can move from the review evidence down to the action naturally.
          On narrow viewports, action buttons wrap beneath the title.
          ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3 border-b pb-4">
        <Button variant="ghost" size="sm" asChild className="shrink-0">
          <Link href="/workspace/reviews">
            <ArrowLeftIcon data-icon="inline-start" />
            Reviews
          </Link>
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              Review -- {lead?.fullName ?? lead?.email ?? "Unknown Lead"}
            </h1>
            {statusCfg && (
              <Badge className={cn("text-xs", statusCfg.badgeClass)}>
                {statusCfg.label}
              </Badge>
            )}
            {review.status === "resolved" && (
              <Badge
                variant="outline"
                className="border-green-300 text-xs text-green-700 dark:border-green-800 dark:text-green-400"
              >
                Resolved
              </Badge>
            )}
          </div>
          {lead?.email && (
            <p className="mt-1 text-xs text-muted-foreground">
              {lead.email}
              {lead.phone && <> &middot; {lead.phone}</>}
            </p>
          )}
        </div>

        {isPending && (
          <ReviewResolutionActions
            reviewId={review._id}
            closerResponse={review.closerResponse}
            opportunityStatus={opportunity.status}
            meetingScheduledAt={meeting.scheduledAt}
            meetingDurationMinutes={meeting.durationMinutes}
            fathomLink={meeting.fathomLink ?? undefined}
            activeFollowUp={activeFollowUp}
            className="ml-auto justify-end"
          />
        )}
      </div>

      {/* Contextual banner explaining narrowed action set (if applicable) */}
      {isPending && (
        <ReviewResolutionContext
          opportunityStatus={opportunity.status}
          activeFollowUp={activeFollowUp}
        />
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Main grid — 3 columns on large screens.
          Left 2/3 holds the high-density outcome evidence + related
          cards. Right 1/3 is the compact context sidebar.
          ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── Left column: outcome, fathom, closer response, resolution ── */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ReviewOutcomeCard
            opportunity={opportunity}
            meeting={meeting}
            closerName={closerName}
            paymentRecords={paymentRecords}
            lostByUserName={lostByUserName}
            noShowByUserName={noShowByUserName}
            activeFollowUp={activeFollowUp}
          />

          <FathomCard meeting={meeting} />

          <CloserResponseCard review={review} />

          <ResolutionCard review={review} resolverName={resolverName} />

          {review.status === "resolved" &&
            review.manualStartedAt !== undefined &&
            review.manualStoppedAt !== undefined && (
              <Card>
                <CardHeader>
                  <CardTitle>Admin-entered meeting times</CardTitle>
                  <CardDescription>
                    Set by {timesSetterName ?? resolverName ?? "admin"}
                    {(review.timesSetAt ?? review.resolvedAt) !== undefined &&
                      ` on ${format(
                        new Date(review.timesSetAt ?? review.resolvedAt!),
                        "MMM d, yyyy 'at' h:mm a",
                      )}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Started:</span>{" "}
                    {format(
                      new Date(review.manualStartedAt),
                      "MMM d, yyyy 'at' h:mm a",
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Ended:</span>{" "}
                    {format(
                      new Date(review.manualStoppedAt),
                      "MMM d, yyyy 'at' h:mm a",
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Duration:</span>{" "}
                    {Math.round(
                      (review.manualStoppedAt - review.manualStartedAt) /
                        60_000,
                    )}{" "}
                    min
                  </div>
                </CardContent>
              </Card>
            )}
        </div>

        {/* ── Right column: system detection, meeting, lead ── */}
        <div className="flex flex-col gap-4">
          <SystemDetectionCard
            review={review}
            meeting={meeting}
            closerName={closerName}
            closerEmail={closerEmail}
          />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <VideoIcon className="size-4" aria-hidden />
                Meeting Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <CalendarDaysIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium">
                    {format(
                      new Date(meeting.scheduledAt),
                      "EEE, MMM d, yyyy",
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(meeting.scheduledAt), "h:mm a")}
                    {" -- "}
                    {format(
                      new Date(
                        meeting.scheduledAt + meeting.durationMinutes * 60_000,
                      ),
                      "h:mm a",
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
                <span>{meeting.durationMinutes} minutes scheduled</span>
              </div>
              {meeting.meetingJoinUrl && (
                <div className="flex items-center gap-2">
                  <VideoIcon className="size-4 shrink-0 text-muted-foreground" />
                  <a
                    href={meeting.meetingJoinUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-primary underline-offset-4 hover:underline"
                  >
                    Join URL
                  </a>
                </div>
              )}
              {meeting.callClassification && (
                <Badge variant="outline" className="text-xs">
                  {meeting.callClassification === "new"
                    ? "New Call"
                    : "Follow-Up Call"}
                </Badge>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <UserIcon className="size-4" aria-hidden />
                Lead Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {lead ? (
                <>
                  <div className="flex items-center gap-2">
                    <UserIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">
                      {lead.fullName ?? "No name"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MailIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="break-all">{lead.email}</span>
                  </div>
                  {lead.phone && (
                    <div className="flex items-center gap-2">
                      <PhoneIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span>{lead.phone}</span>
                    </div>
                  )}
                  {lead.socialHandles && lead.socialHandles.length > 0 && (
                    <div className="mt-2 space-y-1 border-t pt-2">
                      {lead.socialHandles.map((handle, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <span className="capitalize">{handle.type}:</span>
                          <span className="text-foreground">
                            {handle.handle}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="italic text-muted-foreground">
                  Lead information not available.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton — mirrors the redesigned layout so there's no CLS on first paint.
// ---------------------------------------------------------------------------

function ReviewDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-3 border-b pb-4">
        <Skeleton className="h-9 w-24" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-3 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* Context banner */}
      <Skeleton className="h-9 w-full rounded-md" />

      {/* Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

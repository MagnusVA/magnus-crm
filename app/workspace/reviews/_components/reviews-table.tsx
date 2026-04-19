"use client";

import { useRouter } from "next/navigation";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  opportunityStatusConfig,
  isValidOpportunityStatus,
  type OpportunityStatus,
} from "@/lib/status-config";
import { format } from "date-fns";
import { CheckCircle2Icon, EyeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
//
// `EnrichedReview` is auto-synced with the backend query return shape.
// If `listPendingReviews` gains or loses a field, the compiler will flag
// any stale consumption here.
// ---------------------------------------------------------------------------

type EnrichedReview =
  FunctionReturnType<typeof api.reviews.queries.listPendingReviews>[number];

type ReviewsTableProps = {
  reviews: EnrichedReview[] | undefined;
  statusFilter: "pending" | "resolved";
};

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const resolutionLabels: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-up Scheduled",
  mark_no_show: "Marked No-Show",
  mark_lost: "Marked Lost",
  acknowledged: "Acknowledged",
  // v2: dispute resolution label
  disputed: "Disputed",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReviewsTable({ reviews, statusFilter }: ReviewsTableProps) {
  const router = useRouter();

  // Loading state
  if (reviews === undefined) {
    return (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Closer</TableHead>
              <TableHead>Fathom</TableHead>
              <TableHead>Current State</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="mt-1 h-3 w-36" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-28 rounded-full" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto h-8 w-16" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  // Empty state
  if (reviews.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16">
        <CheckCircle2Icon className="size-10 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">
          No reviews to show
        </p>
        <p className="text-xs text-muted-foreground/70">
          All clear — no flagged meetings in this category.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Closer</TableHead>
            <TableHead>Fathom</TableHead>
            <TableHead>Current State</TableHead>
            <TableHead>Detected</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviews.map((row) => {
            const {
              review,
              meeting,
              opportunity,
              activeFollowUp,
              leadName,
              leadEmail,
              closerName,
              opportunityStatus,
            } = row;

            const isDisputedResolved =
              review.status === "resolved" &&
              review.resolutionAction === "disputed";

            return (
              <TableRow
                key={review._id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() =>
                  router.push(`/workspace/reviews/${review._id}`)
                }
              >
                {/* Lead */}
                <TableCell>
                  <div className="font-medium">{leadName}</div>
                  {leadEmail && (
                    <div className="text-xs text-muted-foreground">
                      {leadEmail}
                    </div>
                  )}
                </TableCell>

                {/* Closer */}
                <TableCell className="text-muted-foreground">
                  {closerName}
                </TableCell>

                {/* v2: Fathom presence — primary attendance signal */}
                <TableCell>
                  {meeting?.fathomLink ? (
                    <Badge
                      variant="outline"
                      className="text-xs text-emerald-700 dark:text-emerald-400"
                    >
                      Provided
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-xs text-amber-700 dark:text-amber-400"
                    >
                      Missing
                    </Badge>
                  )}
                </TableCell>

                {/* v2: Current State — merges v1 "Stated Outcome" + "Opp
                    Status" into one signal the admin actually cares about.
                    Priority: disputed (red) → resolution label → follow-up
                    pending → opp status. */}
                <TableCell>
                  <CurrentStateCell
                    review={review}
                    opportunity={opportunity}
                    opportunityStatus={opportunityStatus}
                    activeFollowUp={activeFollowUp}
                    isDisputedResolved={isDisputedResolved}
                  />
                </TableCell>

                {/* Detected */}
                <TableCell className="tabular-nums text-sm text-muted-foreground">
                  {format(new Date(review.createdAt), "MMM d, yyyy")}
                </TableCell>

                {/* Action (View button for keyboard-first navigation;
                    row click is a parallel affordance for mouse) */}
                <TableCell className="text-right">
                  {statusFilter === "pending" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/workspace/reviews/${review._id}`);
                      }}
                    >
                      <EyeIcon data-icon="inline-start" />
                      View
                    </Button>
                  ) : (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-xs",
                        isDisputedResolved &&
                          "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400",
                      )}
                    >
                      {review.resolutionAction
                        ? (resolutionLabels[review.resolutionAction] ??
                          review.resolutionAction)
                        : "Resolved"}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CurrentStateCell — extracted for readability
// ---------------------------------------------------------------------------

function CurrentStateCell({
  review,
  opportunity,
  opportunityStatus,
  activeFollowUp,
  isDisputedResolved,
}: {
  review: EnrichedReview["review"];
  opportunity: EnrichedReview["opportunity"];
  opportunityStatus: EnrichedReview["opportunityStatus"];
  activeFollowUp: EnrichedReview["activeFollowUp"];
  isDisputedResolved: boolean;
}) {
  // Disputed resolved review — red badge, highest priority signal.
  if (isDisputedResolved) {
    return (
      <Badge
        variant="outline"
        className="text-xs text-red-700 dark:text-red-400"
      >
        Disputed
      </Badge>
    );
  }

  // Any other resolved state — show the resolution label.
  if (review.status === "resolved" && review.resolutionAction) {
    return (
      <Badge variant="outline" className="text-xs">
        {resolutionLabels[review.resolutionAction] ?? review.resolutionAction}
      </Badge>
    );
  }

  // Pending + closer created a follow-up while still meeting_overran.
  if (opportunityStatus === "meeting_overran" && activeFollowUp) {
    return (
      <Badge
        variant="outline"
        className="text-xs text-blue-700 dark:text-blue-400"
      >
        Follow-up pending
      </Badge>
    );
  }

  // Pending — show opportunity status.
  if (opportunityStatus && isValidOpportunityStatus(opportunityStatus)) {
    const config =
      opportunityStatusConfig[opportunityStatus as OpportunityStatus];
    return (
      <Badge variant="outline" className={config?.badgeClass}>
        {config?.label ?? opportunityStatus}
      </Badge>
    );
  }

  // Fallback — no opportunity context available.
  // (We reference `opportunity` so TS treats the prop as used for future
  // extensions like joined meeting/lead data.)
  void opportunity;
  return <span className="text-xs text-muted-foreground">{"\u2014"}</span>;
}

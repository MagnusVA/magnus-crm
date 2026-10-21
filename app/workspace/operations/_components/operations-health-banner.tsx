"use client";

import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function OperationsHealthBanner() {
  const unmapped = useQuery(api.operations.unmappedUtms.listRecentUnmappedUtms, {});
  const work = useQuery(api.operations.workStatus.health, {});
  const bookingReviews = useQuery(api.pipeline.bookingReviews.openCount, {});
  const reviewCount = bookingReviews?.count ?? 0;
  const unmappedCount = unmapped?.length ?? 0;
  const problems = work?.queues.filter(q => q.kind.endsWith(":failed") || q.kind.endsWith(":blocked")) ?? [];
  const issueCount = problems.reduce((sum, q) => sum + q.count, 0);
  const updating = work?.queues.some(q => q.kind !== "webhooks:queued" && q.kind.endsWith(":queued") && q.count > 0);
  const capped = problems.some(q => q.capped);
  if (!unmappedCount && !issueCount && !updating && !reviewCount) return null;

  return (
    <>
      {reviewCount > 0 && (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Bookings need a person decision</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {reviewCount}
              {bookingReviews?.capped ? "+" : ""} booking
              {reviewCount === 1 && !bookingReviews?.capped ? "" : "s"} matched more than one
              person.
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href="/workspace/operations/booking-reviews">Review bookings</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {(unmappedCount > 0 || issueCount > 0) && (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>Operations health needs review</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {unmappedCount > 0 && <span>{unmappedCount} booking UTM values need mapping. </span>}
              {issueCount > 0 && <span>{issueCount}{capped ? "+" : ""} booking or reporting issues need review.</span>}
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href="/workspace/operations/booked-calls/attribution?section=diagnostics">
                Review issues
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {updating && (
        <p role="status" className="text-sm text-muted-foreground">
          Reports are updating; displayed totals may lag recent changes.
        </p>
      )}
    </>
  );
}

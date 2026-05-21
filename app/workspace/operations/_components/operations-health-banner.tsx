"use client";

import Link from "next/link";
import { AlertTriangleIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function OperationsHealthBanner() {
  const unmapped = useQuery(api.operations.unmappedUtms.listRecentUnmappedUtms, {});
  const bookingIssues = useQuery(
    api.operations.bookingHealth.listRecentBookingHealthIssues,
    {},
  );

  const unmappedCount = unmapped?.length ?? 0;
  const bookingIssueCount = bookingIssues?.length ?? 0;

  if (unmappedCount === 0 && bookingIssueCount === 0) {
    return null;
  }

  return (
    <Alert>
      <AlertTriangleIcon />
      <AlertTitle>Operations health needs review</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {unmappedCount} recent booking UTM values are unmapped and{" "}
          {bookingIssueCount} recent invitee.created webhooks are unprocessed.
        </span>
        <Button asChild variant="outline" size="sm">
          <Link href="/workspace/settings?tab=attribution">Review mappings</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

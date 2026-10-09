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
  const unmappedCount = unmapped?.length ?? 0;
  const problems = work?.queues.filter(q => q.kind.endsWith(":failed") || q.kind.endsWith(":blocked")) ?? [];
  const issueCount = problems.reduce((sum, q) => sum + q.count, 0);
  const updating = work?.queues.some(q => q.kind !== "webhooks:queued" && q.kind.endsWith(":queued") && q.count > 0);
  const capped = problems.some(q => q.capped);
  if (!unmappedCount && !issueCount && !updating) return null;

  return (
    <Alert>
      <AlertTriangleIcon />
      <AlertTitle>Operations health needs review</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {unmappedCount} booking UTM values need mapping. {issueCount}{capped ? "+" : ""} booking or reporting issues need review. {updating ? "Reports are updating; displayed totals may lag recent changes." : ""}
        </span>
        <Button asChild variant="outline" size="sm">
          <Link href="/workspace/operations/booked-calls/attribution?section=diagnostics">
            Review issues
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

"use client";

import { useCallback, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusTabs } from "./_components/status-tabs";
import { OpportunityTable } from "./_components/opportunity-table";
import { CloserEmptyState } from "../_components/closer-empty-state";
import { Button } from "@/components/ui/button";
import { KanbanIcon } from "lucide-react";
import {
  isValidOpportunityStatus,
  type OpportunityStatus,
} from "@/lib/status-config";

/**
 * Closer Pipeline page — `/workspace/closer/pipeline`
 *
 * Shows the closer's opportunities in a filterable table with status tabs.
 * Clicking a tab filters the list by status. The `?status=` URL query param
 * is synced bidirectionally — the pipeline‑strip cards on the dashboard can
 * deep‑link here with a pre‑selected filter, and tab changes update the URL
 * so the browser back button and shared links work as expected.
 *
 * Two independent Convex subscriptions:
 *   – `getPipelineSummary` → tab count badges (always fetches all statuses)
 *   – `listMyOpportunities` → table rows (filtered by active status)
 *
 * They update independently — when a new meeting creates an opportunity,
 * both the counts and the list react in real time.
 */
export default function CloserPipelinePage() {
  usePageTitle("My Pipeline");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const statusParam = searchParams.get("status");
  const initialStatus =
    statusParam && isValidOpportunityStatus(statusParam)
      ? statusParam
      : undefined;

  const [statusFilter, setStatusFilter] = useState<
    OpportunityStatus | undefined
  >(initialStatus);

  // Sync tab changes back to URL so the back button and shared links work
  // (web-design-guidelines: URL reflects state)
  const handleStatusChange = useCallback(
    (status: OpportunityStatus | undefined) => {
      setStatusFilter(status);
      const params = new URLSearchParams(searchParams.toString());
      if (status) {
        params.set("status", status);
      } else {
        params.delete("status");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Two independent subscriptions (vercel-react-best-practices)
  const pipelineSummary = useQuery(api.closer.dashboard.getPipelineSummary);
  const opportunities = useQuery(api.closer.pipeline.listMyOpportunities, {
    statusFilter,
  });

  // ── Loading ─────────────────────────────────────────────────────────────
  if (pipelineSummary === undefined || opportunities === undefined) {
    return <PipelineSkeleton />;
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-pretty">My Pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Track your opportunities and meeting outcomes
        </p>
      </div>

      {/* Status filter tabs */}
      <StatusTabs
        activeStatus={statusFilter}
        counts={pipelineSummary.counts}
        total={pipelineSummary.total}
        onStatusChange={handleStatusChange}
      />

      {/* Opportunity table */}
      {opportunities.length === 0 ? (
        <CloserEmptyState
          title={
            statusFilter
              ? `No ${statusFilter.replace(/_/g, " ")} opportunities`
              : "No opportunities yet"
          }
          description={
            statusFilter
              ? "Try selecting a different status filter above."
              : "Opportunities will appear here when leads book meetings through Calendly."
          }
          icon={KanbanIcon}
        >
          {statusFilter && (
            <Button variant="outline" size="sm" onClick={() => handleStatusChange(undefined)}>
              Show all opportunities
            </Button>
          )}
        </CloserEmptyState>
      ) : (
        <OpportunityTable opportunities={opportunities} />
      )}
    </div>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function PipelineSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
      <div className="flex flex-col gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>
    </div>
  );
}

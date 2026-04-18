"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTitle } from "@/hooks/use-page-title";
import { ReviewsTable } from "./reviews-table";

type StatusFilter = "pending" | "resolved";

export function ReviewsPageClient() {
  usePageTitle("Meeting Reviews");

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");

  const reviews = useQuery(api.reviews.queries.listPendingReviews, {
    statusFilter,
  });
  const pendingCount = useQuery(api.reviews.queries.getPendingReviewCount);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Meeting Reviews</h1>
        <p className="mt-2 text-muted-foreground">
          Review flagged meetings that need admin attention
        </p>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as StatusFilter)}
      >
        <TabsList variant="line">
          <TabsTrigger value="pending">
            Pending
            {pendingCount !== undefined && (
              <Badge variant="secondary" className="ml-1.5">
                {pendingCount.count}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
        </TabsList>
      </Tabs>

      <ReviewsTable reviews={reviews} statusFilter={statusFilter} />
    </div>
  );
}

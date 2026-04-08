import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the pipeline summary card on the admin dashboard.
 * Matches: h-6 heading + 3 rows of h-12 status bars.
 */
export function PipelineSummarySkeleton() {
  return (
    <Card role="status" aria-label="Loading pipeline summary">
      <CardHeader>
        <Skeleton className="h-6 w-36" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

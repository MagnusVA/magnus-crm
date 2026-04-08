import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeleton for the system health card on the admin dashboard.
 * Matches: h-6 heading + h-20 content area.
 */
export function SystemHealthSkeleton() {
  return (
    <Card role="status" aria-label="Loading system health">
      <CardHeader>
        <Skeleton className="h-6 w-32" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-20 w-full" />
      </CardContent>
    </Card>
  );
}

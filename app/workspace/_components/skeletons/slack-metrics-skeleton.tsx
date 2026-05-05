import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SlackMetricsSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 xl:grid-cols-3"
      role="status"
      aria-label="Loading Slack metrics"
    >
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} size="sm">
          <CardHeader>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-28" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-20" />
            <Skeleton className="mt-3 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

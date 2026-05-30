import { GavelIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface PendingOverranReviewsCardProps {
  count: number;
  isTruncated: boolean;
}

export function PendingOverranReviewsCard({
  count,
  isTruncated,
}: PendingOverranReviewsCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <GavelIcon className="size-4" />
          Pending Overran Reviews
        </CardTitle>
        <CardDescription>Current queue, not date-filtered.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant="outline">Current</Badge>
          {isTruncated ? <Badge variant="secondary">2000+</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {count.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

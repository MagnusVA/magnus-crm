"use client";

import Link from "next/link";
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
      <CardContent className="flex items-end justify-between gap-3">
        <div className="text-2xl font-bold tabular-nums">
          {count.toLocaleString()}
        </div>
        <Link
          href="/workspace/reviews"
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Open inbox
        </Link>
      </CardContent>
    </Card>
  );
}

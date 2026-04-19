"use client";

import { UsersIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AvgMeetingsPerSaleCardProps {
  avg: number | null;
  numerator: number;
  denominator: number;
}

export function AvgMeetingsPerSaleCard({
  avg,
  numerator,
  denominator,
}: AvgMeetingsPerSaleCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <UsersIcon className="size-4" />
          Avg Meetings / Sale
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {avg === null ? "\u2014" : avg.toFixed(2)}
        </div>
        <p className="text-xs text-muted-foreground">
          {numerator.toLocaleString()} meetings across{" "}
          {denominator.toLocaleString()} winning opportunities
        </p>
      </CardContent>
    </Card>
  );
}

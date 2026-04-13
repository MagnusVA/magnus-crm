"use client";

import { TrendingUpIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface VelocityMetricCardProps {
  velocityDays: number | null;
}

export function VelocityMetricCard({ velocityDays }: VelocityMetricCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUpIcon className="h-5 w-5 text-muted-foreground" />
          Pipeline Velocity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1">
          <span className="text-4xl font-bold tabular-nums tracking-tight">
            {velocityDays !== null
              ? `${velocityDays.toFixed(1)} days`
              : "\u2014"}
          </span>
          <span className="text-sm text-muted-foreground">
            Average days from first meeting to payment
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

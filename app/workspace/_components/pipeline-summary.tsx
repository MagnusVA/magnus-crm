"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { opportunityStatusConfig } from "@/lib/status-config";

interface Stats {
  totalClosers: number;
  unmatchedClosers: number;
  totalTeamMembers: number;
  activeOpportunities: number;
  meetingsToday: number;
  wonDeals: number;
  totalOpportunities: number;
}

interface PipelineSummaryProps {
  stats: Stats;
}

export function PipelineSummary({ stats }: PipelineSummaryProps) {
  const statuses = [
    {
      label: "Active",
      value: stats.activeOpportunities,
      badgeClass: opportunityStatusConfig.scheduled.badgeClass,
    },
    {
      label: "Won",
      value: stats.wonDeals,
      badgeClass: opportunityStatusConfig.payment_received.badgeClass,
    },
    {
      label: "Total",
      value: stats.totalOpportunities,
      badgeClass: "bg-muted text-muted-foreground border-border",
    },
  ];

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>Pipeline Overview</CardTitle>
        <CardDescription>Current opportunity mix</CardDescription>
      </CardHeader>
      <CardContent className="pt-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 2xl:grid-cols-1">
          {statuses.map((status) => (
            <div
              key={status.label}
              className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm text-muted-foreground">
                  {status.label}
                </span>
                <Badge className={status.badgeClass} variant="secondary">
                  {status.label}
                </Badge>
              </div>
              <span className="font-mono text-2xl font-bold tabular-nums">
                {status.value}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

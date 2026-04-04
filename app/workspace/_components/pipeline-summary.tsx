"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pipeline Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-6">
          {statuses.map((status) => (
            <div key={status.label} className="flex flex-col gap-2">
              <span className="text-sm text-muted-foreground">{status.label}</span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{status.value}</span>
                <Badge className={status.badgeClass} variant="secondary">
                  {status.label}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

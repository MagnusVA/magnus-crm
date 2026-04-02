"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
      color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    },
    {
      label: "Won",
      value: stats.wonDeals,
      color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
    },
    {
      label: "Total",
      value: stats.totalOpportunities,
      color: "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
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
                <Badge className={status.color} variant="secondary">
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

"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CpuIcon, GitBranchIcon, ShieldIcon, UserIcon } from "lucide-react";

interface ActivitySummaryCardsProps {
  summary: {
    totalEvents: number;
    isTruncated: boolean;
    bySource: Record<string, number>;
  };
}

const SOURCE_CARDS = [
  {
    label: "Closer",
    key: "closer",
    icon: UserIcon,
  },
  {
    label: "Admin",
    key: "admin",
    icon: ShieldIcon,
  },
  {
    label: "Pipeline",
    key: "pipeline",
    icon: GitBranchIcon,
  },
  {
    label: "System",
    key: "system",
    icon: CpuIcon,
  },
] as const;

export function ActivitySummaryCards({ summary }: ActivitySummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {SOURCE_CARDS.map(({ label, key, icon: Icon }) => {
        const count = summary.bySource[key] ?? 0;
        return (
          <Card key={key} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Icon className="h-4 w-4" />
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">{count}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

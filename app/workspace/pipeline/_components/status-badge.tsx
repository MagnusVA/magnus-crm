"use client";

import { Badge } from "@/components/ui/badge";

type OpportunityStatus =
  | "scheduled"
  | "in_progress"
  | "follow_up_scheduled"
  | "payment_received"
  | "lost"
  | "canceled"
  | "no_show";

const statusConfig: Record<OpportunityStatus, { label: string; color: string }> = {
  scheduled: {
    label: "Scheduled",
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  in_progress: {
    label: "In Progress",
    color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  },
  follow_up_scheduled: {
    label: "Follow-up",
    color: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  },
  payment_received: {
    label: "Won",
    color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  },
  lost: {
    label: "Lost",
    color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
  canceled: {
    label: "Canceled",
    color: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  },
  no_show: {
    label: "No Show",
    color: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  },
};

interface StatusBadgeProps {
  status: OpportunityStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status];

  if (!config) {
    return <Badge variant="secondary">{status}</Badge>;
  }

  return (
    <Badge className={config.color} variant="secondary">
      {config.label}
    </Badge>
  );
}

"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CONFIG = {
  active: {
    label: "Active",
    className: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25",
  },
  paused: {
    label: "Paused",
    className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/25",
  },
  churned: {
    label: "Churned",
    className: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
  },
} as const;

export function CustomerStatusBadge({
  status,
}: {
  status: "active" | "churned" | "paused";
}) {
  const config = STATUS_CONFIG[status];
  return (
    <Badge variant="outline" className={cn(config.className)}>
      {config.label}
    </Badge>
  );
}

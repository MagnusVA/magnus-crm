"use client";

import { Badge } from "@/components/ui/badge";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: OpportunityStatus;
  className?: string;
}

/**
 * Unified status badge used across admin and closer views.
 * Always renders the same visual for the same status.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = opportunityStatusConfig[status];

  if (!config) {
    return <Badge variant="secondary">{status}</Badge>;
  }

  return (
    <Badge variant="secondary" className={cn(config.badgeClass, className)}>
      {config.label}
    </Badge>
  );
}

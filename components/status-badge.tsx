"use client";

import { Badge } from "@/components/ui/badge";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition, SystemLossReason } from "@/convex/opportunities/stages";
import { dealPositionConfig } from "@/lib/status-config";
import { cn } from "@/lib/utils";

interface DealStageBadgeProps {
  position: DealPosition;
  /** The system's reason on a loss it wrote, shown as "Lost: no-show". */
  systemLoss?: SystemLossReason | null;
  className?: string;
}

/**
 * The deal's stage badge, the same everywhere a deal shows: its position
 * (Qualified, Booked, Call held, Follow-up, Won, Lost), with the reason when
 * the system closed it (docs/plans/phase-5-deal-status.md §6.1).
 */
export function DealStageBadge({ position, systemLoss, className }: DealStageBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(dealPositionConfig[position].badgeClass, className)}
    >
      {dealPositionLabel(position, systemLoss)}
    </Badge>
  );
}

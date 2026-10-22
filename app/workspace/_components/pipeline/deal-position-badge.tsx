import { Badge } from "@/components/ui/badge";
import type { MissedMeeting } from "@/convex/opportunities/dealState";
import {
  DEAL_POSITION_LABELS,
  SYSTEM_LOSS_REASON_LABELS,
  type DealPosition,
} from "@/convex/opportunities/stages";
import { cn } from "@/lib/utils";

type DealPositionStyle = {
  /** Badge background, text and border classes. */
  badgeClass: string;
  /** Small dot fill, for legends and bars. */
  dotClass: string;
};

/** The colours of each deal position; a new position fails the typecheck until it has some. */
export const DEAL_POSITION_STYLES: Record<DealPosition, DealPositionStyle> = {
  qualified: {
    badgeClass:
      "bg-cyan-500/10 text-cyan-700 border-cyan-200 dark:text-cyan-400 dark:border-cyan-900",
    dotClass: "bg-cyan-500",
  },
  booked: {
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
    dotClass: "bg-blue-500",
  },
  call_held: {
    badgeClass:
      "bg-indigo-500/10 text-indigo-700 border-indigo-200 dark:text-indigo-400 dark:border-indigo-900",
    dotClass: "bg-indigo-500",
  },
  follow_up: {
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
    dotClass: "bg-violet-500",
  },
  won: {
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
    dotClass: "bg-emerald-500",
  },
  lost: {
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
    dotClass: "bg-red-500",
  },
};

/** "Lost", or "Lost: no-show" and "Lost: canceled" for a deal a missed meeting closed. */
export function dealPositionLabel(
  position: DealPosition,
  missedMeeting: MissedMeeting | null,
): string {
  const label = DEAL_POSITION_LABELS[position];
  return missedMeeting
    ? `${label}: ${SYSTEM_LOSS_REASON_LABELS[missedMeeting].toLowerCase()}`
    : label;
}

/** The deal's position, with the missed meeting that closed it. */
export function DealPositionBadge({
  position,
  missedMeeting = null,
  className,
}: {
  position: DealPosition;
  missedMeeting?: MissedMeeting | null;
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(DEAL_POSITION_STYLES[position].badgeClass, className)}
    >
      {dealPositionLabel(position, missedMeeting)}
    </Badge>
  );
}

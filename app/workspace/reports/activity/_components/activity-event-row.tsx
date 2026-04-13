"use client";

import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  ArrowRightLeft,
  BadgeCheck,
  CalendarCheck,
  CalendarPlus,
  CalendarPlus2,
  CalendarX2,
  CheckCircle2,
  Combine,
  DollarSign,
  GitBranch,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Square,
  UserPlus,
  UserRoundCheck,
  UserRoundPlus,
  UserRoundX,
  UserX,
  XCircle,
} from "lucide-react";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  activity: Activity,
  "arrow-right-left": ArrowRightLeft,
  "badge-check": BadgeCheck,
  "calendar-check": CalendarCheck,
  "calendar-plus": CalendarPlus,
  "calendar-plus-2": CalendarPlus2,
  "calendar-x-2": CalendarX2,
  "check-circle-2": CheckCircle2,
  combine: Combine,
  "dollar-sign": DollarSign,
  "git-branch": GitBranch,
  play: Play,
  "refresh-cw": RefreshCw,
  "rotate-ccw": RotateCcw,
  shield: Shield,
  sparkles: Sparkles,
  square: Square,
  "user-plus": UserPlus,
  "user-round-check": UserRoundCheck,
  "user-round-plus": UserRoundPlus,
  "user-round-x": UserRoundX,
  "user-x": UserX,
  "x-circle": XCircle,
};

interface ActivityEventRowProps {
  event: {
    _id: string;
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    metadata: Record<string, unknown> | null;
  };
}

export function ActivityEventRow({ event }: ActivityEventRowProps) {
  const label = getEventLabel(event.eventType);
  const Icon = ICON_MAP[label.iconHint] ?? Activity;

  const fromStatus = event.metadata?.fromStatus as string | undefined;
  const toStatus = event.metadata?.toStatus as string | undefined;

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      {/* Icon */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm">
          <span className="font-medium">
            {event.actorName ?? "System"}
          </span>{" "}
          {label.verb}
        </p>

        {fromStatus && toStatus && (
          <p className="text-xs text-muted-foreground">
            {fromStatus} &rarr; {toStatus}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {formatDistanceToNow(event.occurredAt, { addSuffix: true })}
        </p>
      </div>
    </div>
  );
}

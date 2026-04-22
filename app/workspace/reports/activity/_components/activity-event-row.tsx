"use client";

import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  BadgeCheck,
  CalendarCheck,
  CalendarPlus,
  CalendarPlus2,
  CalendarX2,
  CheckCircle2,
  CircleAlert,
  Combine,
  DollarSign,
  Filter,
  Gavel,
  GitBranch,
  MessageSquare,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  UserPlus,
  UserRoundCheck,
  UserRoundPlus,
  UserRoundX,
  UserX,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  filter: Filter,
  gavel: Gavel,
  "git-branch": GitBranch,
  "message-square": MessageSquare,
  play: Play,
  "refresh-cw": RefreshCw,
  "rotate-ccw": RotateCcw,
  shield: Shield,
  "shield-check": ShieldCheck,
  sparkles: Sparkles,
  square: Square,
  "alert-triangle": AlertTriangle,
  "circle-alert": CircleAlert,
  "undo-2": Undo2,
  "user-plus": UserPlus,
  "user-round-check": UserRoundCheck,
  "user-round-plus": UserRoundPlus,
  "user-round-x": UserRoundX,
  "user-x": UserX,
  "x-circle": XCircle,
};

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  pif: "PIF",
  split: "Split",
  monthly: "Monthly",
  deposit: "Deposit",
};

interface PaymentMetadata {
  programId: string | null;
  programName: string | null;
  paymentType: string;
  commissionable: boolean;
  attributedCloserId: string | null;
  originCategory: string;
}

interface ActivityEventRowProps {
  event: {
    _id: string;
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    fromStatus?: string;
    toStatus?: string;
    metadata: Record<string, unknown> | null;
    paymentMetadata?: PaymentMetadata | null;
  };
}

export function ActivityEventRow({ event }: ActivityEventRowProps) {
  const label = getEventLabel(event.eventType);
  const Icon = ICON_MAP[label.iconHint] ?? Activity;

  const legacyFromStatus =
    typeof event.metadata?.fromStatus === "string"
      ? event.metadata.fromStatus
      : undefined;
  const legacyToStatus =
    typeof event.metadata?.toStatus === "string"
      ? event.metadata.toStatus
      : undefined;
  const fromStatus = event.fromStatus ?? legacyFromStatus;
  const toStatus = event.toStatus ?? legacyToStatus;

  const paymentMetadata =
    event.entityType === "payment" ? event.paymentMetadata ?? null : null;
  const paymentTypeLabel = paymentMetadata
    ? PAYMENT_TYPE_LABELS[paymentMetadata.paymentType] ??
      paymentMetadata.paymentType
    : null;

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"
        title={event.eventType}
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm">
          <span className="font-medium">{event.actorName ?? "System"}</span>{" "}
          {label.verb}
        </p>

        {fromStatus && toStatus && (
          <p className="text-xs text-muted-foreground">
            {fromStatus} &rarr; {toStatus}
          </p>
        )}

        {paymentMetadata ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {paymentMetadata.programName ? (
              <Badge variant="secondary" className="tabular-nums">
                {paymentMetadata.programName}
              </Badge>
            ) : null}
            {paymentTypeLabel ? (
              <Badge variant="outline">{paymentTypeLabel}</Badge>
            ) : null}
            <Badge
              variant={paymentMetadata.commissionable ? "default" : "muted"}
            >
              {paymentMetadata.commissionable
                ? "Commissionable"
                : "Post-Conversion"}
            </Badge>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {formatDistanceToNow(event.occurredAt, { addSuffix: true })}
        </p>
      </div>
    </div>
  );
}

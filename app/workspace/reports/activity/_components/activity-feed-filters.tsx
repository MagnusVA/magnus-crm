"use client";

import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EVENT_LABELS } from "@/convex/reporting/lib/eventLabels";
import { ReportProgramFilter } from "@/app/workspace/reports/_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "@/app/workspace/reports/_components/report-payment-type-filter";
import { MemberIdentityOption } from "@/app/workspace/_components/member-identity";
import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { BAND_SELECT } from "@/app/workspace/reports/_components/report-ui";
import { cn } from "@/lib/utils";

// The feed's filters as board-tone selects in the report band's filters
// slot. The payment filters show only while payment events can match.

const ENTITY_TYPE_OPTIONS = [
  { label: "All records", value: "__all__" },
  { label: "Customer", value: "customer" },
  { label: "Enrollment", value: "enrollment" },
  { label: "Follow-up", value: "followUp" },
  { label: "Lead", value: "lead" },
  { label: "Meeting", value: "meeting" },
  { label: "Deal", value: "opportunity" },
  { label: "Payment", value: "payment" },
  { label: "Team member", value: "user" },
] as const;

const EVENT_TYPE_OPTIONS = [
  { label: "All events", value: "__all__" },
  ...Object.entries(EVENT_LABELS)
    .map(([key, { verb }]) => ({
      label: verb.charAt(0).toUpperCase() + verb.slice(1),
      value: key,
    }))
    .sort((left, right) => left.label.localeCompare(right.label)),
];

const PAYMENT_RELATED_EVENT_PREFIXES = ["payment.", "customer.paid", "deal."];

type EntityType =
  | "customer"
  | "enrollment"
  | "followUp"
  | "lead"
  | "meeting"
  | "opportunity"
  | "payment"
  | "user";

export interface ActivityFilters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
}

interface ActivityFeedFiltersProps {
  filters: ActivityFilters;
  onChange: (filters: ActivityFilters) => void;
  actorBreakdown: Array<{
    actorUserId: string;
    actorName: string | null;
    actor: MemberAvatarIdentity;
    count: number;
  }>;
}

function shouldShowPaymentFilters(filters: ActivityFilters): boolean {
  // Always show when explicitly scoped to payment entities
  if (filters.entityType === "payment") {
    return true;
  }
  // If entity type is "All" (undefined) and no eventType filter, expose them so
  // payment-bearing events can be narrowed.
  if (!filters.entityType && !filters.eventType) {
    return true;
  }
  // Allow when the event type is clearly payment-related.
  if (
    filters.eventType &&
    PAYMENT_RELATED_EVENT_PREFIXES.some((prefix) =>
      filters.eventType!.startsWith(prefix),
    )
  ) {
    return true;
  }
  return false;
}

export function ActivityFeedFilters({
  filters,
  onChange,
  actorBreakdown,
}: ActivityFeedFiltersProps) {
  const showPaymentFilters = shouldShowPaymentFilters(filters);

  return (
    <>
      {/* Entity Type filter */}
      <Select
        value={filters.entityType ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.entityType;
          } else {
            next.entityType = value as EntityType;
          }
          // If switching away from payment-relevant filters, clear them
          if (
            !shouldShowPaymentFilters(next) &&
            (next.programId || next.paymentType)
          ) {
            delete next.programId;
            delete next.paymentType;
          }
          onChange(next);
        }}
      >
        <SelectTrigger aria-label="Record" className={cn(BAND_SELECT, "w-[150px] max-w-full")}>
          <SelectValue placeholder="Record" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Record</SelectLabel>
            {ENTITY_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Event Type filter */}
      <Select
        value={filters.eventType ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.eventType;
          } else {
            next.eventType = value;
          }
          if (
            !shouldShowPaymentFilters(next) &&
            (next.programId || next.paymentType)
          ) {
            delete next.programId;
            delete next.paymentType;
          }
          onChange(next);
        }}
      >
        <SelectTrigger aria-label="Event" className={cn(BAND_SELECT, "w-[230px] max-w-full")}>
          <SelectValue placeholder="Event" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Event</SelectLabel>
            {EVENT_TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Actor filter */}
      <Select
        value={filters.actorUserId ?? "__all__"}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === "__all__") {
            delete next.actorUserId;
          } else {
            next.actorUserId = value;
          }
          onChange(next);
        }}
      >
        <SelectTrigger aria-label="Who" className={cn(BAND_SELECT, "w-[200px] max-w-full")}>
          <SelectValue placeholder="Who" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Who</SelectLabel>
            <SelectItem value="__all__">Everyone</SelectItem>
            {actorBreakdown.filter((actor) => actor.actorUserId !== "removed").map((actor) => (
              <SelectItem key={actor.actorUserId} value={actor.actorUserId}>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <MemberIdentityOption identity={actor.actor} />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {actor.count}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Payment-scoped filters (payment program + payment type) — only rendered when
          the current entity/event-type filter makes payment rows relevant. */}
      {showPaymentFilters ? (
        <>
          <ReportProgramFilter
            value={filters.programId}
            onChange={(nextProgramId) => {
              const next = { ...filters };
              if (nextProgramId) {
                next.programId = nextProgramId;
              } else {
                delete next.programId;
              }
              onChange(next);
            }}
          />
          <ReportPaymentTypeFilter
            value={filters.paymentType}
            onChange={(nextPaymentType) => {
              const next = { ...filters };
              if (nextPaymentType) {
                next.paymentType = nextPaymentType;
              } else {
                delete next.paymentType;
              }
              onChange(next);
            }}
          />
          <span className="text-[13px] text-board-muted">
            <HelpTip tip="The program and payment type filters match payment events only. Pick a program or type to see just those payments.">
              Payments only
            </HelpTip>
          </span>
        </>
      ) : null}
    </>
  );
}

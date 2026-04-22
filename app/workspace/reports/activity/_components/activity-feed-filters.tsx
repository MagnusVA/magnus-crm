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

const ENTITY_TYPE_OPTIONS = [
  { label: "All", value: "__all__" },
  { label: "Customer", value: "customer" },
  { label: "Follow-Up", value: "followUp" },
  { label: "Lead", value: "lead" },
  { label: "Meeting", value: "meeting" },
  { label: "Opportunity", value: "opportunity" },
  { label: "Payment", value: "payment" },
  { label: "User", value: "user" },
] as const;

const EVENT_TYPE_OPTIONS = [
  { label: "All", value: "__all__" },
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
  | "followUp"
  | "lead"
  | "meeting"
  | "opportunity"
  | "payment"
  | "user";

interface Filters {
  entityType?: EntityType;
  eventType?: string;
  actorUserId?: string;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
}

interface ActivityFeedFiltersProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  actorBreakdown: Array<{
    actorUserId: string;
    actorName: string | null;
    count: number;
  }>;
}

function shouldShowPaymentFilters(filters: Filters): boolean {
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
    <div className="flex flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-3">
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
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Entity Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Entity Type</SelectLabel>
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
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder="Event Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Event Type</SelectLabel>
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
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Actor" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Actor</SelectLabel>
            <SelectItem value="__all__">All</SelectItem>
            {actorBreakdown.map((actor) => (
              <SelectItem key={actor.actorUserId} value={actor.actorUserId}>
                {actor.actorName ?? "Unknown"} ({actor.count})
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {/* Payment-scoped filters (program + payment type) — only rendered when
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
        </>
      ) : null}
    </div>
      {showPaymentFilters ? (
        <p className="text-xs text-muted-foreground">
          Program and Payment Type filters apply only to payment events
          (payment.*, customer.paid, deal.*). Narrow to the Payment entity or
          a payment event type above to see richer payment-specific columns.
        </p>
      ) : null}
    </div>
  );
}
